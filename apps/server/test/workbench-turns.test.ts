import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityRecorder,
  ActivityRepository,
  ActivityStore,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  readActivityContent,
  readAttemptActivity,
  SecretRedaction,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type AttemptId,
  type CommandOutput,
  DEFAULT_ACTIVITY_LIMITS,
  EMPTY_HOB_POLICY,
  type Message,
  type TaskTree,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ActivityRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { ActivityStoreLive, FolderScannerLive } from "@hobbots/workbench";
import { Deferred, Effect, Layer, ManagedRuntime, Schedule, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #577: a lead's later turns on its Task resume its Attempt, so one Attempt holds several
// turns' Workbench records. Each turn's commands stay, and the Attempt's budgets hold across turns.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-workbench-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let project = "";
/** More folders the hob has beside its project, for a test that needs them. */
let others: ReadonlyArray<string> = [];
const dataFolder = join(temp, "data");

const now = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const threadId = ThreadId.make("docs");
/** A prompt with this line of its own waits, after its turn's baseline, until the test lets it go on. */
const HOLD = "fake:hold";
/** A token as a command could print it. */
const _TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const HUB_SECRET = "hub-credential-0123456789";
/** A short known secret, whose redaction marker is longer than the secret itself. */
const SHORT_SECRET = "pw-9x8y7z";
const _PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const ProjectTools = Layer.effect(
  HobTools,
  Effect.sync(() =>
    HobTools.of({
      access: (agent) =>
        Effect.succeed({
          policy: {
            preset: "balanced",
            sharedFolders: [project, ...others],
            hob: EMPTY_HOB_POLICY,
            dataFolder,
            restrictions: [],
          },
          folders: [project, ...others],
          runtimeFolder: join(temp, "runtime", agent.id),
          commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
        }),
    }),
  ),
);

/** The fake runtime, with every session whose prompt holds `HOLD` waiting for the gate. */
const held = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          requests.push(request);
          const stream = fake.sendPrompt(request);
          return request.prompt.split("\n").some((line) => line.trim() === HOLD)
            ? Stream.unwrap(Effect.as(Deferred.await(gate), stream))
            : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

const Seed = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(
      new Agent({
        id: ALDRIC,
        name: "Aldric",
        roleTitle: "Writer",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        configVersion: 1,
        createdAt: now,
      }),
    );
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: ALDRIC, title: "Docs", createdAt: now, updatedAt: now }),
    );
  }),
);

// Small limits, so a test can pass them; no retention window, so a Task's details clear once it ends.
const limits = { ...DEFAULT_ACTIVITY_LIMITS, imageBytes: 64, retentionDays: 0 };

const makeApp = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>, kept = limits) =>
  ChatService.layer.pipe(
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(
      ActivityRecorder.layer(kept).pipe(
        Layer.provideMerge(Layer.merge(FolderScannerLive, ActivityStoreLive(join(dataFolder, "activity")))),
      ),
    ),
    Layer.provideMerge(Seed),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        ActivityRepositoryLive,
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        ProjectTools,
        HobAdmission.layer,
        SecretRedaction.layer([
          { value: HUB_SECRET, kind: "HUB_TOKEN" },
          { value: SHORT_SECRET, kind: "SHORT_PASSWORD" },
        ]),
        held(gate, requests),
      ),
    ),
    Layer.provideMerge(TestDatabase),
  );

type App = ReturnType<typeof makeApp>;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<App>, Layer.Error<App>> | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

let projects = 0;
/** A fresh project folder with `files`, and the hub around it. */
const setUp = (
  files: Record<string, string | Uint8Array>,
  options: { readonly limits?: typeof limits; readonly others?: ReadonlyArray<string> } = {},
) => {
  others = options.others ?? [];
  project = join(temp, `project-${++projects}`);
  mkdirSync(project, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(project, path, ".."), { recursive: true });
    writeFileSync(join(project, path), contents);
  }
  const requests: Array<PromptRequest> = [];
  const gate = Deferred.makeUnsafe<void>();
  const app = ManagedRuntime.make(makeApp(gate, requests, options.limits));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  // Every command's output shown live, as clients receive it.
  const live: Array<CommandOutput> = [];
  app.runFork(
    EventBus.use((bus) =>
      bus.stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "Transient" && event.event._tag === "CommandOutput") live.push(event.event);
          }),
        ),
      ),
    ),
  );
  return { run, live, requests, release: () => run(Deferred.succeed(gate, undefined)) };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 1_000 }));

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;
const run = (command: object) => `fake:run ${JSON.stringify(command)}`;

/** Sends a message in the thread and waits until every reply in it has ended. */
const say = (prompt: string) =>
  Effect.gen(function* () {
    const before = (yield* HobbotsRepository.use((repo) => repo.listMessages(threadId))).length;
    yield* ChatService.use((chat) => chat.sendPrompt(threadId, prompt));
    return yield* retry(
      Effect.gen(function* () {
        const all: ReadonlyArray<Message> = yield* HobbotsRepository.use((repo) => repo.listMessages(threadId));
        const ended = all.every((m) => m.status !== "streaming" && m.status !== "stopping");
        return ended && all.length >= before + 2 ? all : yield* Effect.fail("not yet" as const);
      }),
    );
  });

const treeWhen = (ready: (tree: TaskTree) => boolean) =>
  retry(
    Effect.gen(function* () {
      const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
      return tree !== undefined && ready(tree) ? tree : yield* Effect.fail("not yet" as const);
    }),
  );

const activityOf = (attemptId: AttemptId) => ActivityRepository.use((repo) => readAttemptActivity(repo, attemptId));
/** The Attempt's activity once its turns' end-of-turn compares, which land just after their replies end, are in. */
const endedActivity = (attemptId: AttemptId, turns = 1) =>
  retry(
    Effect.flatMap(activityOf(attemptId), (activity) =>
      activity.scans.filter((scan) => scan.phase === "end").length >= turns
        ? Effect.succeed(activity)
        : Effect.fail("not yet" as const),
    ),
  );

const _textOf = (attemptId: AttemptId, contentId: string | null | undefined) =>
  Effect.gen(function* () {
    const repo = yield* ActivityRepository;
    const store = yield* ActivityStore;
    const bytes = yield* readActivityContent(repo, store, attemptId, contentId as never);
    return new TextDecoder().decode(bytes);
  });

describe("an Attempt that several turns work in", () => {
  // covers UX-002, EX-001
  it("[TC-OR-316] keeps each turn's commands, even when the runtime numbers its steps from one again", async () => {
    const { run: inHub } = setUp({ "notes.md": "# Notes\n" });
    await inHub(say(["Tidy the notes", hub("start_quest", { key: "quest", goal: "Tidy the notes" })].join("\n")));
    // Two turns, each the fake runtime's first tool step of its session: the same step id twice.
    await inHub(say(["Format them", run({ command: "npm run format" })].join("\n")));
    await inHub(say(["Lint them", run({ command: "npm run lint" })].join("\n")));
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    expect(tree.attempts.map((each) => each.number)).toEqual([1]);
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const activity = await inHub(endedActivity(attempt.id, 3));
    expect(activity.commands.map((each) => each.command)).toEqual(["npm run format", "npm run lint"]);
  }, 30_000);

  // covers UX-002, PE-005
  it("[TC-OR-317] counts what earlier turns kept against the Attempt's content and log budgets", async () => {
    const text = (mark: string) => `${mark.repeat(999)}\n`;
    // Longer than a command's preview, so the hub keeps it as a log.
    const long = Array.from({ length: 3_000 }, (_, i) => `line ${i + 1}`).join("\n");
    // Room for one file's contents and one log in the whole Attempt, not one per turn.
    const { run: inHub } = setUp(
      {},
      { limits: { ...limits, contentsPerAttempt: 1_500, logBytes: 4_000, logsPerAttempt: 6_000 } },
    );
    await inHub(say(["Draft the notes", hub("start_quest", { key: "quest", goal: "Draft the notes" })].join("\n")));
    await inHub(
      say(["First draft", run({ command: "draft a", writes: { "a.txt": text("a") }, output: long })].join("\n")),
    );
    await inHub(
      say(["Second draft", run({ command: "draft b", writes: { "b.txt": text("b") }, output: long })].join("\n")),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const activity = await inHub(endedActivity(attempt.id, 3));
    // The first turn's file and log fit; the second turn's do not, though its own turn kept nothing yet.
    expect(activity.changes.map(({ path, after }) => [path, after?.notKept ?? null])).toEqual([
      ["a.txt", null],
      ["b.txt", "attempt-limit"],
    ]);
    expect(activity.commands.map(({ command, logNotKept }) => [command, logNotKept])).toEqual([
      ["draft a", null],
      ["draft b", "attempt-limit"],
    ]);
  }, 30_000);

  // covers UX-002, PE-005
  it("[TC-OR-318] a later turn that edits a file an earlier turn kept keeps its before-version, counted once", async () => {
    // Room for one 1,000-byte content in the Attempt, not two.
    const { run: inHub } = setUp({}, { limits: { ...limits, contentsPerAttempt: 1_500 } });
    await inHub(say(["Draft the notes", hub("start_quest", { key: "quest", goal: "Draft the notes" })].join("\n")));
    await inHub(
      say(["First draft", run({ command: "draft", writes: { "a.txt": `${"a".repeat(999)}\n` } })].join("\n")),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const first = await inHub(endedActivity(attempt.id, 2));
    const kept = first.changes[0]?.after?.contentId;
    expect(kept).toEqual(expect.any(String));

    await inHub(say(["Redo it", run({ command: "redo", writes: { "a.txt": `${"b".repeat(999)}\n` } })].join("\n")));
    const activity = await inHub(endedActivity(attempt.id, 3));
    // The first draft is already kept and counted, so the edit's before-version names it; only the
    // new draft would pass the budget.
    expect(activity.changes.map(({ path, before, after }) => [path, before, after?.notKept])).toEqual([
      ["a.txt", expect.objectContaining({ contentId: kept, notKept: null }), "attempt-limit"],
    ]);
  }, 30_000);

  // covers UX-002, PE-005
  it("[TC-OR-319] counts an earlier turn's text at its redacted size, so a later turn cannot pass the budget", async () => {
    // 1,000 bytes as written, 2,700 once each secret in it reads as its marker.
    const secrets = `${SHORT_SECRET}\n`.repeat(100);
    const { run: inHub } = setUp({}, { limits: { ...limits, contentsPerAttempt: 4_000 } });
    await inHub(say(["Write the files", hub("start_quest", { key: "quest", goal: "Write the files" })].join("\n")));
    await inHub(say(["The secrets", run({ command: "write secrets", writes: { "secrets.txt": secrets } })].join("\n")));
    // Once it is deleted, only the deletion's before-version keeps it, and no later scan sees it.
    await inHub(say(["Drop them", run({ command: "drop secrets", writes: { "secrets.txt": null } })].join("\n")));
    // 2,000 more bytes fit beside the 1,000 written, but not beside the 2,700 kept.
    await inHub(
      say(["The rest", run({ command: "write rest", writes: { "rest.txt": `${"r".repeat(1_999)}\n` } })].join("\n")),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const activity = await inHub(endedActivity(attempt.id, 4));
    expect(
      activity.changes.map(({ path, before, after }) => [path, before?.contentId ?? null, after?.notKept ?? null]),
    ).toEqual([
      ["rest.txt", null, "attempt-limit"],
      ["secrets.txt", expect.any(String), null],
    ]);
  }, 30_000);
});

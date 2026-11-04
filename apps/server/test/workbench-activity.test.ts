import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  readCommandLog,
  SecretRedaction,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type AttemptId,
  CommandId,
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

// Issue #384: what a Task did, recorded for the Workbench (ADR 023), with the hub's own composition
// of the recorder, the folder scanner and the store, the fake runtime making real changes in a real
// folder, and the records on SQLite or PostgreSQL (TestDatabase).

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
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const HUB_SECRET = "hub-credential-0123456789";
/** A short known secret, whose redaction marker is longer than the secret itself. */
const SHORT_SECRET = "pw-9x8y7z";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

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

const textOf = (attemptId: AttemptId, contentId: string | null | undefined) =>
  Effect.gen(function* () {
    const repo = yield* ActivityRepository;
    const store = yield* ActivityStore;
    const bytes = yield* readActivityContent(repo, store, attemptId, contentId as never);
    return new TextDecoder().decode(bytes);
  });

describe("a Task's activity", () => {
  // covers UX-002, PE-005
  it("[TC-GEN-082] a Task that edits two files and runs a command has both changes and the command's output recorded, redacted", async () => {
    const { run: inHub } = setUp({
      "notes.md": "# Notes\n",
      "src/app.ts": "export const app = 1;\n",
      ".env": "API_TOKEN=old\n",
      "logo.png": PNG,
      "banner.png": new Uint8Array(limits.imageBytes + 1),
      "untouched.md": "Leave me\n",
    });
    const printed = `Formatted 2 files\nGH_TOKEN=${TOKEN}\nused ${HUB_SECRET}\n`;
    await inHub(
      say(
        [
          "Tidy the docs",
          // A file tool's edit…
          'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
          // …and a command's, with one more it makes, one it deletes and an image it overwrites.
          run({
            command: `npm run format -- --token ${TOKEN}`,
            writes: {
              "src/app.ts": "export const app = 2;\n",
              "src/new.ts": "export {};\n",
              ".env": "API_TOKEN=new\n",
              "untouched.md": null,
              "logo.png": "redrawn\n",
              "banner.png": null,
            },
            output: printed,
          }),
          // The Attempt the turn's records wait for, started after the work.
          hub("start_quest", { key: "quest", goal: "Tidy docs" }),
        ].join("\n"),
      ),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const activity = await inHub(endedActivity(attempt.id));

    // The command, its folder, its sandbox and its output, with every secret redacted.
    expect(activity.commands).toHaveLength(1);
    const [command] = activity.commands;
    expect(command).toMatchObject({
      taskId: tree.tasks[0]?.id,
      folder: project,
      sandboxed: true,
      liveOutput: false,
      state: "succeeded",
      exitCode: 0,
    });
    expect(command?.command).toBe("npm run format -- --token [redacted: GitHub token]");
    expect(command?.output?.head).toBe(
      "Formatted 2 files\nGH_TOKEN=[redacted: GitHub token]\nused [redacted: HUB_TOKEN]\n",
    );
    expect(JSON.stringify(activity)).not.toContain(TOKEN);
    expect(JSON.stringify(activity)).not.toContain(HUB_SECRET);

    // Both edits, however they were made, and what the command added and deleted.
    expect(activity.changes.map(({ path, kind, settled }) => ({ path, kind, settled }))).toEqual([
      { path: ".env", kind: "edited", settled: true },
      { path: "banner.png", kind: "deleted", settled: true },
      { path: "logo.png", kind: "edited", settled: true },
      { path: "notes.md", kind: "edited", settled: true },
      { path: "src/app.ts", kind: "edited", settled: true },
      { path: "src/new.ts", kind: "added", settled: true },
      { path: "untouched.md", kind: "deleted", settled: true },
    ]);
    const change = (path: string) => {
      const found = activity.changes.find((each) => each.path === path);
      if (found === undefined) throw new Error(`no change to ${path}`);
      return found;
    };
    const kept = (path: string, side: "before" | "after") => change(path)[side]?.contentId;
    expect(await inHub(textOf(attempt.id, kept("notes.md", "before")))).toBe("# Notes\n");
    expect(await inHub(textOf(attempt.id, kept("notes.md", "after")))).toBe("# Notes\n\nTidied.\n");
    expect(await inHub(textOf(attempt.id, kept("src/app.ts", "after")))).toBe("export const app = 2;\n");
    expect(await inHub(textOf(attempt.id, kept("untouched.md", "before")))).toBe("Leave me\n");
    // A file whose name marks it as secret keeps no contents.
    expect(change(".env").before).toMatchObject({ contentId: null, notKept: "secret" });
    expect(change(".env").after).toMatchObject({ contentId: null, notKept: "secret" });
    // The image's earlier version is kept as it was.
    expect(change("logo.png").before).toMatchObject({ kind: "image", notKept: null });
    const earlier = await inHub(
      Effect.gen(function* () {
        const repo = yield* ActivityRepository;
        const store = yield* ActivityStore;
        return yield* readActivityContent(repo, store, attempt.id, kept("logo.png", "before") as never);
      }),
    );
    expect(earlier).toEqual(PNG);
    // One past the size limit says why its earlier version is not kept.
    expect(change("banner.png").before).toMatchObject({ kind: "image", contentId: null, notKept: "too-large" });

    // The scans the changes were found by, and the journal entries each record committed with.
    expect(activity.scans.map(({ folder, phase, stopped }) => ({ folder, phase, stopped }))).toEqual([
      { folder: project, phase: "start", stopped: null },
      { folder: project, phase: "end", stopped: null },
    ]);
    const types = await inHub(
      EventJournal.use((journal) => journal.readAfter(0, 10_000)).pipe(Effect.map((all) => all.map((e) => e.type))),
    );
    expect(types).toEqual(expect.arrayContaining(["CommandRecorded", "FileChangesRecorded", "FolderScanned"]));
  }, 30_000);

  // covers UX-002, UX-006, PE-005 (#902)
  it("[TC-GEN-157] a colored command keeps its colors in the Workbench, redacted where a color splits a secret, and its reply step reads plain", async () => {
    const { run: inHub } = setUp({ "notes.md": "# Notes\n" });
    const green = "\u001b[32m";
    const bold = "\u001b[1m";
    const reset = "\u001b[m";
    // `git diff` as it prints in color, with a token a color code splits in two.
    const printed = `${bold}diff --git a/.env b/.env${reset}\n${green}+GH=${TOKEN.slice(0, 12)}${bold}${TOKEN.slice(12)}${reset}\n`;
    const messages = await inHub(
      say(
        [
          "Show the diff",
          run({ command: "git diff", output: printed }),
          hub("start_quest", { key: "quest", goal: "Diff" }),
        ].join("\n"),
      ),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const activity = await inHub(endedActivity(attempt.id));

    const [command] = activity.commands;
    expect(command?.output?.head).toBe(
      `${bold}diff --git a/.env b/.env${reset}\n${green}+GH=[redacted: GitHub token]${bold}${reset}\n`,
    );
    const reply = messages.find((message) => message.steps.some((step) => step.kind === "tool"));
    const step = reply?.steps.find((each) => each.kind === "tool");
    expect(step?.output?.head).toBe("diff --git a/.env b/.env\n+GH=[redacted: GitHub token]\n");
    // The prompt and its echo carry the command as scripted; what the hub recorded of it does not.
    const steps = messages.flatMap((message) => message.steps);
    expect(JSON.stringify(steps)).not.toContain("\\u001b");
    expect(JSON.stringify({ activity, steps })).not.toContain(TOKEN.slice(12));
  });

  // covers UX-002
  it("[TC-GEN-083] a step records on its own Attempt, keeps a long output as a log, and labels changes made beside another step", async () => {
    const { run: inHub, release, live } = setUp({ "README.md": "# Site\n" });
    const long = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const short = `built\nGH_TOKEN=${TOKEN}\n`;
    const step = (name: string, file: string, output: string, shown: boolean) => ({
      brief: [name, HOLD, run({ command: `make ${name}`, writes: { [file]: `${name}\n` }, output, live: shown })].join(
        "\n",
      ),
    });
    await inHub(
      say(
        [
          "Build the site",
          hub("plan_steps", {
            key: "plan",
            steps: [step("pages", "pages.html", long, false), step("styles", "site.css", short, true)],
          }),
        ].join("\n"),
      ),
    );
    await release();
    const tree = await inHub(
      treeWhen((each) =>
        each.tasks.filter((task) => task.parentId !== null).every((task) => task.state === "completed"),
      ),
    );
    const steps = tree.tasks.filter((task) => task.parentId !== null);
    const attemptOf = (taskId: string) => tree.attempts.find((each) => each.taskId === taskId);
    const [pages, styles] = steps.map((each) => attemptOf(each.id));
    if (pages === undefined || styles === undefined) throw new Error("no step Attempts");
    const pagesActivity = await inHub(endedActivity(pages.id));
    const stylesActivity = await inHub(endedActivity(styles.id));

    expect(pagesActivity.commands.map((each) => each.command)).toEqual(["make pages"]);
    expect(stylesActivity.commands.map((each) => each.command)).toEqual(["make styles"]);
    // Each step records its own file. The two commands ran at once in the same folder, so a step may
    // also hold the other's file, but only labeled as shared with that step, naming its hob (#595).
    const ownFile = (activity: typeof pagesActivity, file: string, other: typeof pages) => {
      expect(activity.changes.map((each) => each.path)).toContain(file);
      for (const change of activity.changes) {
        expect(change.sharedWith).not.toContain(activity.attempt.id);
        if (change.path === file) continue;
        expect(change.sharedWith).toContain(other.id);
        expect(activity.sharedWithHobs).toContainEqual({ attemptId: other.id, agentId: other.agentId });
      }
    };
    ownFile(pagesActivity, "pages.html", styles);
    ownFile(stylesActivity, "site.css", pages);
    // The output is long: its record keeps its start and end, and its whole output is a log.
    const [command] = pagesActivity.commands;
    expect(command?.output).toMatchObject({ logged: true });
    expect(command?.output?.omittedBytes).toBeGreaterThan(0);
    expect(command?.log).toMatchObject({ omittedBytes: 0 });
    const log = await inHub(
      Effect.gen(function* () {
        return yield* readCommandLog(yield* ActivityRepository, yield* ActivityStore, pages.id, command?.id as never);
      }),
    );
    expect(log).toBe(long);
    // The styles step's output was shown live as it came, each piece redacted, on its own Attempt.
    const [shown] = stylesActivity.commands;
    expect(shown?.liveOutput).toBe(true);
    expect(live.map((each) => each.delta).join("")).toBe("built\nGH_TOKEN=[redacted: GitHub token]\n");
    expect(live.map((each) => each.delta).join("")).toBe(shown?.output?.head);
    expect(live.every((each) => each.attemptId === styles.id && each.commandId === shown?.id)).toBe(true);
  }, 30_000);

  // covers UX-002, PE-005
  it("[TC-PE-279] clears the details of a Task past the retention window and never touches the hob's files", async () => {
    const { run: inHub } = setUp({ "notes.md": "# Notes\n" });
    await inHub(
      say(
        [
          "Finish the notes",
          'fake:write notes.md "# Notes\\n\\nDone.\\n"',
          hub("start_quest", { key: "quest", goal: "Finish" }),
          hub("complete_task", { key: "done", summary: "The notes are finished." }),
        ].join("\n"),
      ),
    );
    const tree = await inHub(treeWhen((each) => each.tasks[0]?.state === "completed"));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const before = await inHub(endedActivity(attempt.id));
    const kept = before.changes[0]?.after?.contentId;
    expect(kept).not.toBeNull();

    await inHub(ActivityRecorder.use((recorder) => recorder.prune));

    const after = await inHub(activityOf(attempt.id));
    expect(after.detailsClearedAt).not.toBeNull();
    expect(after.changes[0]).toMatchObject({ path: "notes.md", after: { contentId: null, notKept: "cleared" } });
    expect(existsSync(join(dataFolder, "activity", kept ?? ""))).toBe(false);
    expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("# Notes\n\nDone.\n");
  }, 30_000);
  // covers UX-002, PE-005
  it("[TC-PE-282] keeps one content budget for the whole Attempt, across its folders, and frees a version a rewrite replaced", async () => {
    const second = join(temp, "second");
    mkdirSync(second, { recursive: true });
    const text = (mark: string) => `${mark.repeat(999)}\n`;
    const setUpWith = (contentsPerAttempt: number) =>
      setUp({}, { limits: { ...limits, contentsPerAttempt }, others: [second] });
    // The turn waits after its baseline while the test writes in the second folder, then rewrites a.txt twice.
    const turn = [
      "Tidy both",
      HOLD,
      run({ command: "draft one", writes: { "a.txt": text("1") } }),
      run({ command: "draft two", writes: { "a.txt": text("2") } }),
      run({ command: "draft three", writes: { "a.txt": text("3") } }),
      run({ command: "draft c", writes: { "c.txt": text("c") } }),
      // The fake writes only in the first folder: the test writes b.txt, and the hob's Write names it (#595).
      `fake:write ${join(second, "b.txt")} ${JSON.stringify(text("b"))}`,
      hub("start_quest", { key: "quest", goal: "Tidy both" }),
    ].join("\n");
    const recorded = async (contentsPerAttempt: number) => {
      rmSync(second, { recursive: true, force: true });
      mkdirSync(second, { recursive: true });
      const { run: inHub, release, requests } = setUpWith(contentsPerAttempt);
      const sent = inHub(say(turn));
      // The prompt reaches the runtime once the turn's baseline is taken.
      await inHub(retry(Effect.suspend(() => (requests.length > 0 ? Effect.void : Effect.fail("not yet" as const)))));
      writeFileSync(join(second, "b.txt"), text("b"));
      await release();
      await sent;
      const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
      const attempt = tree.attempts[0];
      if (attempt === undefined) throw new Error("no Attempt");
      const activity = await inHub(endedActivity(attempt.id, 2));
      await runtime?.dispose();
      runtime = undefined;
      return activity.changes.map(({ path, after }) => ({ path, notKept: after?.notKept ?? null }));
    };

    // Room for the three files as they end: the versions of a.txt its rewrites replaced were freed.
    expect(await recorded(3_000)).toEqual([
      { path: "a.txt", notKept: null },
      { path: "c.txt", notKept: null },
      { path: "b.txt", notKept: null },
    ]);
    // Room for two: the third, in the other folder, is past what the Attempt may keep.
    const tight = await recorded(2_500);
    expect(tight.filter((each) => each.notKept === "attempt-limit")).toHaveLength(1);
    expect(tight.filter((each) => each.notKept === null)).toHaveLength(2);
  }, 30_000);
  // covers UX-002, EX-004
  it("[TC-PE-283] after a restart, a command left running from before it is recorded as uncertain, with its journal entry", async () => {
    const { run: inHub } = setUp({ "notes.md": "# Notes\n" });
    await inHub(say(["Check the notes", hub("start_quest", { key: "quest", goal: "Check" })].join("\n")));
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    await inHub(endedActivity(attempt.id));
    // What a hub that stopped mid-command leaves behind: the command's record says it still runs.
    await inHub(
      ActivityRepository.use((repo) =>
        repo.saveCommand({
          id: CommandId.make("left-running"),
          attemptId: attempt.id,
          stepId: "lost-step",
          command: "npm test",
          folder: project,
          sandboxed: true,
          liveOutput: false,
          state: "running",
          exitCode: null,
          startedAt: now,
          endedAt: null,
          output: null,
          log: null,
          logNotKept: null,
        }),
      ),
    );
    const before = await inHub(EventJournal.use((journal) => journal.readAfter(0, 10_000)));

    // The hub starts again: its recorder settles what no turn still runs.
    await inHub(Effect.scoped(Layer.build(ActivityRecorder.layer(limits))));

    const activity = await inHub(activityOf(attempt.id));
    const command = activity.commands.find((each) => each.id === "left-running");
    expect(command).toMatchObject({ state: "uncertain", exitCode: null });
    expect(command?.endedAt).not.toBeNull();
    const after = await inHub(EventJournal.use((journal) => journal.readAfter(before.at(-1)?.sequence ?? 0, 10_000)));
    expect(after.filter((entry) => entry.type === "CommandRecorded").map((entry) => entry.payload)).toMatchObject([
      { _tag: "CommandRecorded", command: { id: "left-running", state: "uncertain" } },
    ]);
  }, 30_000);
  // covers UX-002, EX-004
  it("[TC-PE-453] after a restart, an Attempt's steps left under way are ended and journaled before they are served (#892)", async () => {
    const { run: inHub } = setUp({ "notes.md": "# Notes\n" });
    await inHub(say(["Check the notes", hub("start_quest", { key: "quest", goal: "Check" })].join("\n")));
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    await inHub(endedActivity(attempt.id));
    // What a hub that stopped mid-turn leaves behind: a tool still running and a step still waiting.
    await inHub(
      ActivityRepository.use((repo) =>
        repo.saveSteps(
          attempt.id,
          [
            { id: "searching", kind: "tool", label: "Searching GitHub", state: "running", startedAt: now },
            { id: "asking", kind: "tool", label: "Asking to edit files", state: "awaiting", startedAt: now },
            { id: "read", kind: "tool", label: "Reading a file", state: "done", startedAt: now },
          ],
          now,
        ),
      ),
    );
    const before = await inHub(EventJournal.use((journal) => journal.readAfter(0, 10_000)));

    // The hub starts again: its recorder ends what no turn still runs.
    await inHub(Effect.scoped(Layer.build(ActivityRecorder.layer(limits))));

    const activity = await inHub(activityOf(attempt.id));
    expect(activity.steps.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "searching", state: "uncertain" },
      { id: "asking", state: "unfinished" },
      { id: "read", state: "done" },
    ]);
    const after = await inHub(EventJournal.use((journal) => journal.readAfter(before.at(-1)?.sequence ?? 0, 10_000)));
    expect(after.filter((entry) => entry.type === "AttemptStepsRecorded")).toHaveLength(1);

    // A second start finds nothing left under way, so it journals nothing more.
    const settled = await inHub(EventJournal.use((journal) => journal.readAfter(0, 10_000)));
    await inHub(Effect.scoped(Layer.build(ActivityRecorder.layer(limits))));
    const again = await inHub(EventJournal.use((journal) => journal.readAfter(settled.at(-1)?.sequence ?? 0, 10_000)));
    expect(again.filter((entry) => entry.type === "AttemptStepsRecorded")).toHaveLength(0);
  }, 30_000);
  // covers PE-005
  it("[TC-PE-286] counts a text's redacted size against the Attempt's budget, so redaction never takes it past", async () => {
    // 1,000 bytes as written, and longer once each secret in it reads as its marker.
    const secrets = `${SHORT_SECRET}\n`.repeat(100);
    const { run: inHub } = setUp({}, { limits: { ...limits, contentsPerAttempt: 1_000 } });
    await inHub(
      say(
        [
          "Write the files",
          run({ command: "write secrets", writes: { "secrets.txt": secrets } }),
          hub("start_quest", { key: "quest", goal: "Write" }),
        ].join("\n"),
      ),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const activity = await inHub(endedActivity(attempt.id));
    expect(activity.changes.map(({ path, after }) => ({ path, after: after?.notKept }))).toEqual([
      { path: "secrets.txt", after: "attempt-limit" },
    ]);
  }, 30_000);
});

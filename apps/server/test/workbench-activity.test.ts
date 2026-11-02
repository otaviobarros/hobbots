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
const dataFolder = join(temp, "data");

const now = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const threadId = ThreadId.make("docs");
/** A prompt with this line of its own waits, after its turn's baseline, until the test lets it go on. */
const HOLD = "fake:hold";
/** A token as a command could print it. */
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const HUB_SECRET = "hub-credential-0123456789";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const ProjectTools = Layer.effect(
  HobTools,
  Effect.sync(() =>
    HobTools.of({
      access: (agent) =>
        Effect.succeed({
          policy: {
            preset: "balanced",
            sharedFolders: [project],
            hob: EMPTY_HOB_POLICY,
            dataFolder,
            restrictions: [],
          },
          folders: [project],
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

const makeApp = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>) =>
  ChatService.layer.pipe(
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(
      ActivityRecorder.layer(limits).pipe(
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
        SecretRedaction.layer([{ value: HUB_SECRET, kind: "HUB_TOKEN" }]),
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
const setUp = (files: Record<string, string | Uint8Array>) => {
  project = join(temp, `project-${++projects}`);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(project, path, ".."), { recursive: true });
    writeFileSync(join(project, path), contents);
  }
  const requests: Array<PromptRequest> = [];
  const gate = Deferred.makeUnsafe<void>();
  const app = ManagedRuntime.make(makeApp(gate, requests));
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
  return { run, live, release: () => run(Deferred.succeed(gate, undefined)) };
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
      exitCode: null,
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
    const change = (path: string) => activity.changes.find((each) => each.path === path);
    expect(await inHub(textOf(attempt.id, change("notes.md")?.before?.contentId))).toBe("# Notes\n");
    expect(await inHub(textOf(attempt.id, change("notes.md")?.after?.contentId))).toBe("# Notes\n\nTidied.\n");
    expect(await inHub(textOf(attempt.id, change("src/app.ts")?.after?.contentId))).toBe("export const app = 2;\n");
    expect(await inHub(textOf(attempt.id, change("untouched.md")?.before?.contentId))).toBe("Leave me\n");
    // A file whose name marks it as secret keeps no contents.
    expect(change(".env")?.before).toMatchObject({ contentId: null, notKept: "secret" });
    expect(change(".env")?.after).toMatchObject({ contentId: null, notKept: "secret" });
    // The image's earlier version is kept as it was.
    expect(change("logo.png")?.before).toMatchObject({ kind: "image", notKept: null });
    const earlier = await inHub(
      Effect.gen(function* () {
        const repo = yield* ActivityRepository;
        const store = yield* ActivityStore;
        return yield* readActivityContent(repo, store, attempt.id, change("logo.png")?.before?.contentId as never);
      }),
    );
    expect(earlier).toEqual(PNG);
    // One past the size limit says why its earlier version is not kept.
    expect(change("banner.png")?.before).toMatchObject({ kind: "image", contentId: null, notKept: "too-large" });

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
    // Each step changed its own file while the other worked in the same folder, so each says so.
    // (The turn that planned them worked there too, until it ended.)
    expect(pagesActivity.changes.find((each) => each.path === "pages.html")?.sharedWith).toContain(styles.id);
    expect(stylesActivity.changes.find((each) => each.path === "site.css")?.sharedWith).toContain(pages.id);
    expect(pagesActivity.changes.find((each) => each.path === "pages.html")?.sharedWith).not.toContain(pages.id);
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
});

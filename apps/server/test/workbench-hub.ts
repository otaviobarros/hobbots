import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityRecorder,
  ActivityRepository,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  RuntimeAdapter,
  readAttemptActivity,
  SecretRedaction,
  TaskRepository,
} from "@hobbots/agents";
import {
  type ActivityLimits,
  Agent,
  AgentId,
  type AttemptId,
  DEFAULT_ACTIVITY_LIMITS,
  EMPTY_HOB_POLICY,
  type Message,
  type TaskTree,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { waitFor, waitUntil } from "@hobbots/domain/testing";
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
import { Deferred, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

/**
 * A hub that records what a Task did for the Workbench (ADR 023): the hub's own composition of the
 * recorder, the folder scanner and the store, the fake runtime making real changes in a real folder,
 * and the records on SQLite or PostgreSQL (TestDatabase). One hob, Aldric, works in a project folder.
 */

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-workbench-hub-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const dataFolder = join(temp, "data");
let project = "";
/** Aldric's folders after the project, which the fake runtime never changes. */
let others: ReadonlyArray<string> = [];

const now = "2026-11-03T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const threadId = ThreadId.make("docs");
/** A prompt with this line of its own waits, after its turn's baseline, until the test lets it go on. */
export const HOLD = "fake:hold";

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
const held = (gate: Deferred.Deferred<void>, prompts: Array<string>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          prompts.push(request.prompt);
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

const makeApp = (gate: Deferred.Deferred<void>, prompts: Array<string>, limits: Partial<ActivityLimits> = {}) =>
  ChatService.layer.pipe(
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(
      ActivityRecorder.layer({ ...DEFAULT_ACTIVITY_LIMITS, retentionDays: 0, ...limits }).pipe(
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
        SecretRedaction.layer([]),
        held(gate, prompts),
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
/**
 * A fresh project folder with `files`, Aldric's folders named `more` beside it, and the hub around
 * them, its turns' scans held to `limits` over the defaults.
 */
export const setUp = (
  files: Record<string, string>,
  more: ReadonlyArray<string> = [],
  limits: Partial<ActivityLimits> = {},
) => {
  project = join(temp, `project-${++projects}`);
  others = more.map((name) => join(temp, `${name}-${projects}`));
  for (const folder of [project, ...others]) mkdirSync(folder, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(project, path, ".."), { recursive: true });
    writeFileSync(join(project, path), contents);
  }
  const gate = Deferred.makeUnsafe<void>();
  // Every prompt the runtime was sent, each once its turn's baseline was taken.
  const prompts: Array<string> = [];
  const app = ManagedRuntime.make(makeApp(gate, prompts, limits));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  /** Waits until `count` turns holding `HOLD` have taken their baselines. */
  const holding = (count: number) =>
    run(
      waitFor(
        `${count} held turns`,
        () => prompts.filter((prompt) => prompt.split("\n").some((line) => line.trim() === HOLD)).length >= count,
      ),
    );
  return { run, folder: project, others, holding, release: () => run(Deferred.succeed(gate, undefined)) };
};

/** A prompt line that makes the fake call a hub tool. */
export const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;
/** A prompt line that makes the fake run a command, with what it writes, prints and how it exits. */
export const fakeRun = (command: object) => `fake:run ${JSON.stringify(command)}`;

/** Sends a message in the thread and waits until every reply in it has ended. */
export const say = (prompt: string) =>
  Effect.gen(function* () {
    const before = (yield* HobbotsRepository.use((repo) => repo.listMessages(threadId))).length;
    yield* ChatService.use((chat) => chat.sendPrompt(threadId, prompt));
    return yield* waitUntil(
      HobbotsRepository.use((repo) => repo.listMessages(threadId)),
      (all: ReadonlyArray<Message>) =>
        all.every((m) => m.status !== "streaming" && m.status !== "stopping") && all.length >= before + 2,
      { what: "every reply to end" },
    );
  });

/** The thread's Task tree, once it is as `ready` wants it. */
export const treeWhen = (ready: (tree: TaskTree) => boolean) =>
  waitUntil(
    Effect.map(
      TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)),
      ([tree]) => tree,
    ),
    (tree): tree is TaskTree => tree !== undefined && ready(tree),
    { what: "the Task tree" },
  );

/** The Attempt's activity once its turns' end-of-turn compares, which land just after their replies end, are in. */
export const endedActivity = (attemptId: AttemptId, turns = 1) =>
  waitUntil(
    ActivityRepository.use((repo) => readAttemptActivity(repo, attemptId)),
    (activity) => activity.scans.filter((scan) => scan.phase === "end").length >= turns,
    { what: `the end-of-turn scans of ${turns} turns` },
  );

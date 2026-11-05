import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  ApprovalService,
  type CharmTools,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  QuestionService,
  RuntimeAdapter,
  TaskControls,
  TaskRepository,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import { LocalGitToolsLive } from "@hobbots/charms";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  type Message,
  type Task,
  type TaskTree,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { Backpack, Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { afterAll, afterEach } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// A hub for party tests on the dependency contract of #563 (ADR 018, ADR 019): Aldric leads, the
// fake runtime plays every hob, and a test holds a hob's turn by name until it lets it go. Hubs
// can start again over one database, as after a restart.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-party-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
export const project = join(temp, "project");
mkdirSync(project, { recursive: true });

const now = "2026-11-03T00:00:00.000Z";
export const ALDRIC = AgentId.make("aldric");
export const QUILL = AgentId.make("quill");
export const ROOK = AgentId.make("rook");
export const PIP = AgentId.make("pip");
export const threadId = ThreadId.make("dependencies");

/** A line `fake:hold <name>` in a prompt waits, before the prompt does anything, until `release(name)`. */
export const hold = (name: string) => `fake:hold ${name}`;
/** A line `fake:hold-started <name>` waits like `hold` once its session has started, so a restart can resume it. */
export const holdStarted = (name: string) => `fake:hold-started ${name}`;

export const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Engineering",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** Every hob works in the project folder under the Balanced preset. */
const ProjectTools = Layer.succeed(
  HobTools,
  HobTools.of({
    access: (agent) =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [project],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(temp, "data"),
          restrictions: [],
        },
        folders: [project],
        runtimeFolder: join(temp, "runtime", agent.id),
      }),
  }),
);

/** The hub creates a repository for a hob, in its own data folder first, as the hub does (ADR 014). */
const LocalGit = LocalGitToolsLive({ stagingFolder: join(temp, "data", "charms", "local-git") }).pipe(
  Layer.provide(Layer.mergeAll(PolicyEngine.node, NodeServices.layer)),
);

/** Lines a later prompt runs once it carries `on`, as a hob reacts to what reaches it. Each reacts once. */
export interface Reaction {
  readonly on: string;
  readonly lines: ReadonlyArray<string>;
}

interface Script {
  readonly requests: Array<PromptRequest>;
  readonly answers: Map<string, string>;
  readonly gates: Map<string, Deferred.Deferred<void>>;
  readonly reactions: Array<Reaction>;
  /** The hub has stopped, as a process killed mid-turn: its backpack never answers again. */
  stopped: boolean;
}

const gateOf = (script: Script, name: string) => {
  const found = script.gates.get(name);
  if (found !== undefined) return found;
  const made = Deferred.makeUnsafe<void>();
  script.gates.set(name, made);
  return made;
};

/** The request with its hub calls' answers kept by the call's key. */
const answering = (request: PromptRequest, answers: Map<string, string>): PromptRequest => {
  const hubTools = request.hubTools;
  if (!hubTools) return request;
  const call: typeof hubTools.call = (name, input, step) =>
    Effect.tap(hubTools.call(name, input, step), (answer) =>
      Effect.sync(() => {
        const key = (input as { readonly key?: unknown } | null)?.key;
        if (typeof key === "string") answers.set(key, answer.text);
      }),
    );
  return { ...request, hubTools: { ...hubTools, call } };
};

/** The prompt with the lines of the first reaction it carries added. */
const reacted = (prompt: string, script: Script) => {
  const index = script.reactions.findIndex((each) => prompt.includes(each.on));
  return index === -1 ? prompt : [prompt, ...(script.reactions.splice(index, 1)[0]?.lines ?? [])].join("\n");
};

const named = (lines: ReadonlyArray<string>, prefix: string) =>
  lines.find((line) => line.startsWith(`${prefix} `))?.slice(prefix.length + 1);

const scripted = (script: Script) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (sent) => {
          const request = answering({ ...sent, prompt: reacted(sent.prompt, script) }, script.answers);
          script.requests.push(request);
          const stream = fake.sendPrompt(request);
          const lines = request.prompt.split("\n").map((line) => line.trim());
          const started = named(lines, "fake:hold-started");
          if (started !== undefined) {
            let running = false;
            return Stream.mapEffect(stream, (event) => {
              const wait = running ? Deferred.await(gateOf(script, started)) : Effect.void;
              running = running || event._tag === "SessionStarted";
              return Effect.as(wait, event);
            });
          }
          const held = named(lines, "fake:hold");
          return held === undefined ? stream : Stream.unwrap(Effect.as(Deferred.await(gateOf(script, held)), stream));
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

/** The backpack, frozen once the hub has stopped: every call it is asked from then on waits forever. */
const stoppable = (script: Script) =>
  Layer.effect(
    Backpack,
    Effect.gen(function* () {
      const live = (yield* Backpack) as unknown as Record<
        string,
        (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>
      >;
      const frozen = Object.fromEntries(
        Object.entries(live).map(([name, method]) => [
          name,
          (...args: ReadonlyArray<unknown>) => Effect.suspend(() => (script.stopped ? Effect.never : method(...args))),
        ]),
      );
      return Backpack.of(frozen as unknown as Backpack["Service"]);
    }),
  ).pipe(Layer.provide(BackpackLive));

const party = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const all = [hob(ALDRIC, "Aldric"), hob(QUILL, "Quill"), hob(ROOK, "Rook"), hob(PIP, "Pip")];
  for (const each of all) yield* repo.insertAgent(each);
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: ALDRIC, title: "Dependencies", createdAt: now, updatedAt: now }),
  );
});

type Database = Layer.Layer<Layer.Success<typeof TestDatabase>>;

/** Charms a test offers its hobs, beside the local Git tools; none by default. */
type Charms = Layer.Layer<CharmTools> | typeof Layer.empty;

const makeHub = (database: Database, script: Script, charms: Charms) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer, TaskControls.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(ContinuationsLive),
    Layer.provideMerge(
      StepRunnerLive().pipe(
        Layer.provideMerge(MemberContinuationsLive),
        Layer.provideMerge(TaskTools.layer("/")),
        Layer.provideMerge(TaskSignal.layer),
      ),
    ),
    Layer.provideMerge(Dispatcher.layer().pipe(Layer.provideMerge(DispatcherHostLive))),
    Layer.provideMerge(Layer.mergeAll(ApprovalService.layer, QuestionService.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        ApprovalRepositoryLive,
        stoppable(script),
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        ProjectTools,
        LocalGit,
        charms,
        HobAdmission.layer,
        scripted(script),
        Layer.succeed(UserSession, {
          deviceId: WINDOW_DEVICE_ID,
          name: "This computer's Hobbots window",
          kind: "window",
          whileApproved: (write) => write,
        }),
      ),
    ),
    Layer.provideMerge(database),
  );

type Hub = ReturnType<typeof makeHub>;
export type HubServices = Layer.Success<Hub>;

const open: Array<ManagedRuntime.ManagedRuntime<HubServices, Layer.Error<Hub>>> = [];
const scripts: Array<Script> = [];
let databaseScope: Scope.Closeable | undefined;

afterEach(async () => {
  // A hub that stopped mid-Quest goes last, its backpack answering again so the turns it left can end.
  for (const script of scripts) script.stopped = false;
  scripts.length = 0;
  for (const each of open.reverse()) await each.dispose();
  open.length = 0;
  if (databaseScope !== undefined) await Effect.runPromise(Scope.close(databaseScope, Exit.void));
  databaseScope = undefined;
});

/** One database that outlives the hubs started over it, with the party stored. */
export const sharedDatabase = async (): Promise<Database> => {
  const scope = await Effect.runPromise(Scope.make());
  databaseScope = scope;
  const database = Layer.succeedContext(await Effect.runPromise(Layer.buildWithScope(TestDatabase, scope)));
  await Effect.runPromise(Effect.provide(party, HobbotsRepositoryLive.pipe(Layer.provideMerge(database))));
  return database;
};

/** Starts a hub over `database`, its hobs reacting as `reactions` say. */
export const startHub = async (
  database: Database,
  reactions: ReadonlyArray<Reaction> = [],
  charms: Charms = Layer.empty,
) => {
  const script: Script = {
    requests: [],
    answers: new Map(),
    gates: new Map(),
    reactions: [...reactions],
    stopped: false,
  };
  const runtime = ManagedRuntime.make(makeHub(database, script, charms));
  open.push(runtime);
  scripts.push(script);
  await runtime.runPromise(Effect.void);
  const run = <A, E>(effect: Effect.Effect<A, E, HubServices>) => runtime.runPromise(effect);
  return {
    run,
    requests: script.requests,
    answers: script.answers,
    release: (name: string) => run(Deferred.succeed(gateOf(script, name), undefined)),
    stop: () => {
      script.stopped = true;
    },
  };
};

export const send = (prompt: ReadonlyArray<string>) =>
  ChatService.use((chat) => chat.sendPrompt(threadId, prompt.join("\n")));

const isLive = (state: string) => state === "starting" || state === "running";

/** The request's whole tree once `ready` holds for it. */
export const treeWhen = (ready: (tree: TaskTree) => boolean) =>
  waitUntil(
    Effect.map(
      TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)),
      ([tree]) => tree,
    ),
    (tree): tree is TaskTree => tree !== undefined && ready(tree),
    { what: "the Task tree" },
  );

/** The tree once `ready` holds for it and nothing runs in it. */
export const settledTree = (ready: (tree: TaskTree) => boolean) =>
  treeWhen((tree) => ready(tree) && !tree.attempts.some((each) => isLive(each.state)));

/** The thread's messages once `ready` holds for them, every reply ended. */
export const messagesWhen = (ready: (all: ReadonlyArray<Message>) => boolean) =>
  waitUntil(
    HobbotsRepository.use((repo) => repo.listMessages(threadId)),
    (all) => all.every((m) => m.status !== "streaming" && m.status !== "stopping") && ready(all),
    { what: "the thread's messages" },
  );

/** Nothing waits in any hob's backpack, routine progress included, nor in yours. */
export const nothingOpen = Effect.asVoid(
  waitUntil(
    Effect.gen(function* () {
      const backpack = yield* Backpack;
      const scopes = [ALDRIC, QUILL, ROOK, PIP].map((agentId) => ({ _tag: "Hob" as const, agentId }));
      const open = [];
      for (const scope of [...scopes, { _tag: "Workspace" as const }]) open.push(...(yield* backpack.listOpen(scope)));
      return open;
    }),
    (open) => open.length === 0,
    { what: "every backpack to be empty" },
  ),
);

/** The Task a member owns in the tree, below the Task you asked for. */
export const memberTask = (tree: TaskTree, agentId: AgentId): Task | undefined =>
  tree.tasks.find((task) => task.ownerId === agentId && task.parentId !== null);

export const taskOf = (tree: TaskTree, agentId: AgentId): Task => {
  const found = memberTask(tree, agentId);
  if (found === undefined) throw new Error(`no Task for ${agentId}`);
  return found;
};

/** The states of a Task's Attempts, oldest first. */
export const attemptsOf = (tree: TaskTree, task: Task) =>
  tree.attempts.filter((each) => each.taskId === task.id).map((each) => each.state);

/** The prompts a member's sessions were sent: its brief, then what arrived for it. */
export const promptsTo = (requests: ReadonlyArray<PromptRequest>, task: Task) =>
  requests.filter(
    (request) =>
      request.prompt.endsWith(`Task id: ${task.id}.`) ||
      (request.prompt.split("\n\n").at(-1) ?? "").startsWith(`You work on Task ${task.id} `),
  );

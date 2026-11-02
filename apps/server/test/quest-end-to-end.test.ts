import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalRepository,
  ApprovalService,
  ChatService,
  GrantService,
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
import {
  Agent,
  AgentId,
  type ApprovalRequest,
  EMPTY_HOB_POLICY,
  type Message,
  type Task,
  type TaskTree,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Backpack, Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Schedule, Scope, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #280: the whole of Tasks and Quests (ADR 018) played end to end, as the slice's done-when
// checks. Each case starts from one message of yours and follows the work to its end:
// steps, a party with a hand-off through its lead, questions answered and passed up, a nested Quest
// whose loop the limits stop, the controls with confirmed outcomes, a This Task grant, and a hub that
// stops mid-Quest and starts again over the same database. The fake runtime plays every hob; your
// later messages tell Aldric what to do next, as you would in his chat.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-quest-e2e-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
mkdirSync(project, { recursive: true });

const now = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const ROOK = AgentId.make("rook");
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("black-friday");
/** A prompt with this line of its own waits, before it does anything, until its hub lets it go on. */
const HOLD = "fake:hold";
/** A prompt with this line waits like HOLD once its session has started, so a restart can resume it. */
const HOLD_STARTED = "fake:hold-started";
/** A prompt with this line of its own runs until it is stopped. */
const UNTIL_STOPPED = "fake:until-stopped";
/**
 * A member's brief with a line `fake:broken <token>` fails, without its hub calls, until the test
 * fixes that token; so does every later turn on the same Task.
 */
const BROKEN = "fake:broken";
/** What a step's own prompt says of it; no other prompt holds it. */
const STEP_MARK = "This is step ";
const push = "fake:tool Bash git push origin feature";

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Marketing",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** Every hob works in the project folder under the Balanced preset: edits run, pushes ask. */
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

/** Lines a later prompt runs once it carries `on`, as a hob reacts to what reaches it. */
interface Reaction {
  readonly on: string;
  readonly lines: ReadonlyArray<string>;
}

/** What one hub's fake runtime was sent and answered, and what it holds back. */
interface Script {
  readonly requests: Array<PromptRequest>;
  /** What the hub answered each scripted call, by the call's key: what the hob read back. */
  readonly answers: Map<string, string>;
  readonly gate: Deferred.Deferred<void>;
  readonly reactions: Array<Reaction>;
  /** The `fake:broken` tokens that work again. */
  readonly fixed: Set<string>;
  /** The token each broken Task's brief carried, by the Task's id. */
  readonly broken: Map<string, string>;
  /**
   * The hub has stopped, as a process killed mid-turn: its backpack never answers again, so its
   * turns renew, claim and settle nothing more, and the next start over the database works alone.
   */
  stopped: boolean;
}

/** The request with its hub calls' answers kept in `answers`. */
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

/**
 * The prompt as the fake runs it: with the first reaction it carries added, and cut off, without
 * its hub calls, while a `fake:broken` token it carries is not fixed.
 */
const scriptedPrompt = (prompt: string, script: Script) => {
  const reaction = script.reactions.findIndex((each) => prompt.includes(each.on));
  const reacted =
    reaction === -1 ? prompt : [prompt, ...(script.reactions.splice(reaction, 1)[0]?.lines ?? [])].join("\n");
  const lines = reacted.split("\n").map((line) => line.trim());
  const token = lines.find((line) => line.startsWith(`${BROKEN} `))?.slice(BROKEN.length + 1);
  const taskId = /Task id: (\S+)\.$/.exec(reacted)?.[1] ?? /You work on Task (\S+) /.exec(reacted)?.[1];
  if (token !== undefined && taskId !== undefined) script.broken.set(taskId, token);
  const breaks = taskId === undefined ? undefined : script.broken.get(taskId);
  if (breaks === undefined || script.fixed.has(breaks)) return reacted;
  return ["fake:cut-off", ...lines.filter((line) => !line.startsWith("fake:hub "))].join("\n");
};

/** The backpack, frozen once the hub has stopped: every call it is asked from then on waits forever. */
const stoppable = (script: Script) =>
  Layer.effect(
    Backpack,
    Effect.gen(function* () {
      // Each of its calls is an Effect, so each is wrapped alike.
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

const scripted = (script: Script) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (sent) => {
          const request = answering({ ...sent, prompt: scriptedPrompt(sent.prompt, script) }, script.answers);
          script.requests.push(request);
          const stream = fake.sendPrompt(request);
          const lines = request.prompt.split("\n");
          if (lines.includes(UNTIL_STOPPED)) return Stream.never;
          if (lines.includes(HOLD_STARTED)) {
            let started = false;
            return Stream.mapEffect(stream, (event) => {
              const wait = started ? Deferred.await(script.gate) : Effect.void;
              started = started || event._tag === "SessionStarted";
              return Effect.as(wait, event);
            });
          }
          return lines.includes(HOLD) ? Stream.unwrap(Effect.as(Deferred.await(script.gate), stream)) : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

/** Aldric, his thread, and the hobs he can bring in, stored once in the shared database. */
const party = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const all = [hob(ALDRIC, "Aldric"), hob(QUILL, "Quill"), hob(ADA, "Ada"), hob(ROOK, "Rook"), hob(PIP, "Pip")];
  for (const each of all) yield* repo.insertAgent(each);
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: ALDRIC, title: "Black Friday", createdAt: now, updatedAt: now }),
  );
});

type Database = Layer.Layer<Layer.Success<typeof TestDatabase>>;

const makeHub = (database: Database, script: Script) =>
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
    Layer.provideMerge(GrantService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        ApprovalRepositoryLive,
        GrantRepositoryLive,
        stoppable(script),
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        ProjectTools,
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
type HubServices = Layer.Success<Hub>;

const open: Array<ManagedRuntime.ManagedRuntime<HubServices, Layer.Error<Hub>>> = [];
const scripts: Array<Script> = [];
let databaseScope: Scope.Closeable | undefined;

afterEach(async () => {
  // A hub that stopped mid-Quest never ended its turns, as after a crash; it goes last, with the database,
  // its backpack answering again so the turns it left can end.
  for (const script of scripts) script.stopped = false;
  scripts.length = 0;
  for (const each of open.reverse()) await each.dispose();
  open.length = 0;
  if (databaseScope !== undefined) await Effect.runPromise(Scope.close(databaseScope, Exit.void));
  databaseScope = undefined;
});

/** One database that outlives the hubs started over it, with the party stored. */
const sharedDatabase = async (): Promise<Database> => {
  const scope = await Effect.runPromise(Scope.make());
  databaseScope = scope;
  const database = Layer.succeedContext(await Effect.runPromise(Layer.buildWithScope(TestDatabase, scope)));
  await Effect.runPromise(Effect.provide(party, HobbotsRepositoryLive.pipe(Layer.provideMerge(database))));
  return database;
};

/** Starts a hub over the database: what it does at start runs before this returns. */
const start = async (database: Database, reactions: ReadonlyArray<Reaction> = []) => {
  const script: Script = {
    requests: [],
    answers: new Map(),
    gate: Deferred.makeUnsafe<void>(),
    reactions: [...reactions],
    fixed: new Set(),
    broken: new Map(),
    stopped: false,
  };
  const runtime = ManagedRuntime.make(makeHub(database, script));
  open.push(runtime);
  scripts.push(script);
  await runtime.runPromise(Effect.void);
  const run = <A, E>(effect: Effect.Effect<A, E, HubServices>) => runtime.runPromise(effect);
  return {
    run,
    script,
    release: () => run(Deferred.succeed(script.gate, undefined)),
    stop: () => {
      script.stopped = true;
    },
  };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 1500 }));

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

const send = (prompt: ReadonlyArray<string>) => ChatService.use((chat) => chat.sendPrompt(threadId, prompt.join("\n")));

const messages = () => HobbotsRepository.use((repo) => repo.listMessages(threadId));

/** The thread's messages once `ready` holds for them, every reply ended. */
const messagesWhen = (ready: (all: ReadonlyArray<Message>) => boolean) =>
  retry(
    Effect.gen(function* () {
      const all = yield* messages();
      const ended = all.every((m) => m.status !== "streaming" && m.status !== "stopping");
      return ended && ready(all) ? all : yield* Effect.fail("not yet" as const);
    }),
  );

/** The request's whole tree once `ready` holds for it. */
const treeWhen = (ready: (tree: TaskTree) => boolean) =>
  retry(
    Effect.gen(function* () {
      const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
      return tree !== undefined && ready(tree) ? tree : yield* Effect.fail("not yet" as const);
    }),
  );

const isLive = (state: string) => state === "starting" || state === "running";

/** The Task of the tree that `agentId` was given by a lead. */
const memberTask = (tree: TaskTree, agentId: AgentId): Task | undefined =>
  tree.tasks.find((task) => task.ownerId === agentId && task.parentId !== null);

const taskOf = (tree: TaskTree, agentId: AgentId): Task => {
  const task = memberTask(tree, agentId);
  if (task === undefined) throw new Error(`No Task for ${agentId}`);
  return task;
};

/** Aldric's own steps: the Tasks under his that he owns. */
const stepsOf = (tree: TaskTree) => tree.tasks.filter((task) => task.ownerId === ALDRIC && task.parentId !== null);

const attemptsOf = (tree: TaskTree, task: Task) =>
  tree.attempts.filter((each) => each.taskId === task.id).map((each) => [each.agentId, each.state]);

/** The prompts a member's sessions were sent: its brief, then what arrived for it. */
const promptsTo = (requests: ReadonlyArray<PromptRequest>, task: Task) =>
  requests.filter(
    (request) =>
      request.prompt.includes(`Task id: ${task.id}.`) ||
      request.prompt.split("\n\n").some((part) => part.startsWith(`You work on Task ${task.id} `)),
  );

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

const settledTree = (ready: (tree: TaskTree) => boolean) =>
  treeWhen((tree) => ready(tree) && !tree.attempts.some((each) => isLive(each.state)));

/** Nothing waits in any hob's backpack, routine progress included, nor in yours. */
const nothingOpen = retry(
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const scopes = [ALDRIC, QUILL, ADA, ROOK, PIP].map((agentId) => ({ _tag: "Hob" as const, agentId }));
    for (const scope of [...scopes, { _tag: "Workspace" as const }]) {
      const open = yield* backpack.listOpen(scope);
      if (open.length > 0) return yield* Effect.fail("not yet" as const);
    }
  }),
);

/** Once nothing that needs the hob waits in its backpack, read or not. */
const nothingFor = (agentId: AgentId) =>
  retry(
    Effect.flatMap(
      Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId })),
      (open) => (open.some((item) => item.actionable) ? Effect.fail("not yet" as const) : Effect.void),
    ),
  );

/** The tree once the hob's turn has ended and what it carried has settled with it. */
const settledFor = (agentId: AgentId) =>
  Effect.andThen(
    nothingFor(agentId),
    treeWhen((tree) => !tree.attempts.some((each) => each.agentId === agentId && isLive(each.state))),
  );

/**
 * Once no turn but `agentId`'s holds anything in a backpack: every other turn has ended and settled
 * what it carried, so a hub stopped now is stopped in that hob's turn alone.
 */
const onlyAtWork = (agentId: AgentId) =>
  retry(
    Effect.flatMap(
      Backpack.use((backpack) => backpack.listOpen({ _tag: "Workspace" })),
      (open) =>
        open.some((item) => item.claim !== null && item.recipientId !== agentId)
          ? Effect.fail("not yet" as const)
          : Effect.void,
    ),
  );

const pendingFrom = (agentId: AgentId) =>
  retry(
    Effect.flatMap(
      ApprovalRepository.use((approvals) => approvals.listPending),
      (all): Effect.Effect<ApprovalRequest, "not yet"> => {
        const found = all.find((each) => each.agentId === agentId);
        return found === undefined ? Effect.fail("not yet") : Effect.succeed(found);
      },
    ),
  );

describe("the Black Friday Quest end to end", () => {
  // covers OR-001, OR-002, OR-003, OR-004, OR-005, IN-002, IN-004
  it("[TC-OR-170] steps, a party with a hand-off, both kinds of question and a nested Quest whose loop is stopped all play out from one request", async () => {
    const database = await sharedDatabase();
    const { run, script, release } = await start(database, [
      // Quill goes on with Aldric's answer, held until Ada has heard yours, so Ada still waits on him.
      { on: 'was answered by hob aldric: "Playful"', lines: [HOLD] },
      // Ada finishes once Quill's copy reaches her through Aldric.
      {
        on: '"Landing copy" was handed to Task',
        lines: [hub("complete_task", { key: "build-done", summary: "Campaign built for Dec 12" })],
      },
    ]);
    const steps = ["Outline the campaign", "Set the prices", "Pick the images", "Proofread everything"];
    await run(
      send([
        "Plan the Black Friday campaign",
        hub("plan_steps", {
          key: "plan",
          steps: steps.map((name, index) => {
            const brief = [name, hub("complete_task", { key: `step-${index + 1}`, summary: `${name}: done` })].join(
              "\n",
            );
            return index === 0 ? { brief } : { brief, after: [index] };
          }),
        }),
        hub("delegate_task", {
          key: "copy",
          hob: "Quill",
          brief: [
            "Draft the landing copy",
            hub("ask", { key: "tone", question: "Playful or formal?" }),
            `fake:then ${hub("complete_task", {
              key: "copy-done",
              summary: "Playful landing copy",
              artifacts: [{ kind: "text", label: "Landing copy", value: "Black Friday: 20% off everything" }],
            })}`,
          ].join("\n"),
        }),
        hub("delegate_task", {
          key: "build",
          hob: "Ada",
          brief: [
            "Build the campaign once the copy exists",
            hub("ask", { key: "date", question: "Launch on Dec 12 for international shoppers?" }),
          ].join("\n"),
          depends_on: ["$copy.task_id"],
        }),
        hub("delegate_task", {
          key: "ads",
          hob: "Rook",
          brief: [
            "Run the ads",
            hub("delegate_task", {
              key: "keywords",
              hob: "Pip",
              brief: [
                "Research the keywords",
                // Pip tries to hand the work back up, and to go one level deeper: both are stopped.
                hub("delegate_task", { key: "pip-to-aldric", hob: "Aldric", brief: "Your turn" }),
                hub("delegate_task", { key: "pip-deeper", hob: "Quill", brief: "Research some more" }),
                hub("complete_task", { key: "keywords-done", summary: "Twelve keywords, led by 'doorbuster'" }),
              ].join("\n"),
            }),
            hub("wait_for", { key: "rook-wait", tasks: ["$keywords.task_id"] }),
            `fake:then ${hub("complete_task", { key: "ads-done", summary: "Ads ready around 'doorbuster'" })}`,
          ].join("\n"),
        }),
      ]),
    );
    // Quill's question reaches Aldric, who answers it himself.
    const asked = await run(treeWhen((tree) => tree.questions.some((each) => each.askerId === QUILL)));
    expect(asked.questions.find((each) => each.askerId === QUILL)?.recipientId).toBe(ALDRIC);
    await run(
      send(["Answer Quill", hub("answer", { key: "reply", question_id: "$tone.question_id", answer: "Playful" })]),
    );

    // Ada's question Aldric passes up to you, and you answer it.
    await run(treeWhen((tree) => tree.questions.some((each) => each.askerId === ADA)));
    await run(send(["Ask the user", hub("escalate", { key: "up", question_id: "$date.question_id" })]));
    const yours = await run(
      treeWhen((tree) => tree.questions.some((each) => each.askerId === ADA && each.recipientId === null)),
    );
    const date = yours.questions.find((each) => each.askerId === ADA);
    if (date === undefined) throw new Error("no question from Ada");
    await run(QuestionService.use((questions) => questions.answer(date.id, "Yes, Dec 12")));
    // Ada goes on with your answer in her own session, and waits on Quill's copy.
    const heard = await run(
      treeWhen((tree) => {
        const ada = memberTask(tree, ADA);
        return ada !== undefined && promptsTo(script.requests, ada).length === 2;
      }).pipe(Effect.andThen(settledFor(ADA))),
    );
    expect(memberTask(heard, ADA)?.state).toBe("waiting");
    expect(memberTask(heard, QUILL)?.state).toBe("active");

    // Quill finishes; his copy reaches Ada only through Aldric.
    await release();
    const copied = await run(treeWhen((tree) => memberTask(tree, QUILL)?.state === "completed"));
    expect(memberTask(copied, ADA)?.state).not.toBe("completed");
    await run(
      send([
        "Hand the copy to Ada",
        hub("hand_off", { key: "hand", artifact_id: "$copy-done.artifacts.0", to_task_id: "$build.task_id" }),
      ]),
    );

    // Once every step and member is done, Aldric wraps up in your chat.
    await run(
      settledTree((tree) => tree.tasks.length > 1 && tree.tasks.slice(1).every((task) => task.state === "completed")),
    );
    await run(send(["Wrap up", hub("complete_task", { key: "wrap", summary: "The Black Friday campaign is ready" })]));
    const done = await run(settledTree((tree) => tree.tasks[0]?.state === "completed"));

    // The tree: your request, four steps of Aldric's, three members and Pip under Rook; the refused calls wrote nothing.
    const [top] = done.tasks;
    const rook = taskOf(done, ROOK);
    const pip = taskOf(done, PIP);
    expect(top?.result?.summary).toBe("The Black Friday campaign is ready");
    expect(stepsOf(done).map((step) => step.brief.split("\n")[0])).toEqual(steps);
    expect(done.tasks).toHaveLength(9);
    expect(done.tasks.every((task) => task.state === "completed")).toBe(true);
    expect(pip.parentId).toBe(rook.id);
    expect(done.quests.map((quest) => [quest.leadId, quest.depth, quest.state])).toEqual([
      [ALDRIC, 1, "completed"],
      [ROOK, 2, "completed"],
    ]);
    expect(script.answers.get("pip-to-aldric")).toMatch(/^Refused \(cycle\): Aldric already owns work/);
    expect(script.answers.get("pip-deeper")).toMatch(/^Refused \(depth-limit\)/);

    // Steps: each ran in a fresh session from its brief, numbered, and Aldric kept only their results.
    const stepPrompts = script.requests.filter((request) => request.prompt.includes(STEP_MARK));
    expect(stepPrompts.map((request) => request.prompt.split("\n")[0])).toEqual(steps);
    expect(stepPrompts[1]?.prompt).toContain(`${STEP_MARK}2 of 4`);
    expect(stepPrompts.every((request) => request.sessionId === null)).toBe(true);
    const others = script.requests.filter((request) => !request.prompt.includes(STEP_MARK));
    const told = (request: PromptRequest) => `${request.briefing ?? ""}${request.prompt}`;
    expect(others.some((request) => told(request).includes("Set the prices: done"))).toBe(true);
    expect(others.some((request) => told(request).includes(STEP_MARK))).toBe(false);

    // Questions: Quill's answered by Aldric, Ada's passed up and answered by you.
    expect(done.questions.map((each) => [each.askerId, each.chain, each.answeredBy, each.answer])).toEqual([
      [QUILL, [], { _tag: "Lead", agentId: ALDRIC }, "Playful"],
      [ADA, [ALDRIC], { _tag: "User" }, "Yes, Dec 12"],
    ]);
    const quillPrompts = promptsTo(script.requests, taskOf(done, QUILL));
    expect(quillPrompts.map((request) => request.sessionId === null)).toEqual([true, false]);
    expect(quillPrompts[1]?.prompt).toContain('was answered by hob aldric: "Playful"');

    // The hand-off: Ada heard your answer, then got Quill's copy from Aldric, in her own session.
    const ada = taskOf(done, ADA);
    expect(done.handOffs.map((each) => each.toTaskId)).toEqual([ada.id]);
    const adaPrompts = promptsTo(script.requests, ada);
    expect(adaPrompts).toHaveLength(3);
    expect(adaPrompts[1]?.prompt).toContain('was answered by the user: "Yes, Dec 12"');
    expect(adaPrompts[2]?.prompt).toContain("Black Friday: 20% off everything");
    expect(new Set(adaPrompts.slice(1).map((request) => request.sessionId)).size).toBe(1);
    expect(ada.result?.summary).toBe("Campaign built for Dec 12");

    // Nesting: Pip deals with Rook only, and her result reaches Rook's session, never Aldric's chat.
    expect(promptsTo(script.requests, pip)[0]?.prompt).toContain(
      "Rook gave you this Task as part of a Quest Rook leads.",
    );
    const replies = continuations(await run(messagesWhen(() => true)))
      .map((reply) => reply.content)
      .join("\n");
    expect(replies).not.toContain("Twelve keywords");
    expect(rook.result?.summary).toBe("Ads ready around 'doorbuster'");

    // Nothing is left for anyone to deal with.
    await run(nothingOpen);
  }, 60_000);

  // covers OR-002, OR-004, OR-006, EX-001
  it("[TC-OR-171] in one Quest, Retry and Reassign finish what failed, Cancel Task stops a nested lead and its member, and Cancel Quest confirms the rest", async () => {
    const database = await sharedDatabase();
    const { run, script, release } = await start(database);
    await run(
      send([
        "Plan the Black Friday campaign",
        hub("plan_steps", {
          key: "plan",
          steps: [
            {
              brief: [
                "Set the prices",
                `${BROKEN} prices`,
                hub("complete_task", { key: "prices-done", summary: "Prices set" }),
              ].join("\n"),
            },
          ],
        }),
        hub("delegate_task", {
          key: "build",
          hob: "Ada",
          brief: [
            "Build the campaign",
            HOLD,
            hub("complete_task", { key: "build-done", summary: "Campaign built" }),
          ].join("\n"),
        }),
        hub("delegate_task", {
          key: "ads",
          hob: "Rook",
          brief: [
            "Run the ads",
            hub("delegate_task", { key: "keywords", hob: "Pip", brief: ["Research the keywords", HOLD].join("\n") }),
            hub("wait_for", { key: "rook-wait", tasks: ["$keywords.task_id"] }),
          ].join("\n"),
        }),
        hub("delegate_task", { key: "images", hob: "Quill", brief: ["Pick the images", UNTIL_STOPPED].join("\n") }),
        hub("wait_for", { key: "wait", tasks: ["$build.task_id", "$ads.task_id", "$images.task_id"] }),
      ]),
    );
    const controls = <A, E>(use: (each: TaskControls["Service"]) => Effect.Effect<A, E, UserSession>) =>
      run(TaskControls.use(use));
    const stateOf = (tree: TaskTree, task: Task) => tree.tasks.find((each) => each.id === task.id)?.state;

    // Cancel Task on Rook's, while Pip works under him, stops her turn, confirms both, and leaves
    // Aldric's Quest going.
    const nested = await run(
      treeWhen(
        (tree) =>
          memberTask(tree, ROOK)?.state === "waiting" &&
          tree.attempts.some((each) => each.agentId === PIP && isLive(each.state)),
      ),
    );
    const rook = taskOf(nested, ROOK);
    const pip = taskOf(nested, PIP);
    await controls((each) => each.cancel(rook.id));
    const cut = await run(
      treeWhen((tree) => stateOf(tree, rook) === "cancelled" && stateOf(tree, pip) === "cancelled"),
    );
    expect(attemptsOf(cut, pip)).toEqual([[PIP, "cancelled"]]);
    expect(cut.tasks[0]?.state).not.toBe("cancelled");
    expect(cut.quests.map((each) => [each.leadId, each.state])).toEqual([
      [ALDRIC, "active"],
      [ROOK, "cancelled"],
    ]);

    // The step's session failed, so the step failed. Once what broke it is fixed and Pip's turn no
    // longer fills the tree's limit, Retry runs it again as a new Attempt of the same Task.
    const stepFailed = await run(treeWhen((tree) => stepsOf(tree)[0]?.state === "failed"));
    const [prices] = stepsOf(stepFailed);
    if (prices === undefined) throw new Error("no step");
    script.fixed.add("prices");
    await controls((each) => each.retry(prices.id));
    // A step completes before its Attempt ends, so both are waited for.
    const priced = await run(
      treeWhen(
        (tree) =>
          stateOf(tree, prices) === "completed" &&
          !tree.attempts.some((each) => each.taskId === prices.id && isLive(each.state)),
      ),
    );
    expect(attemptsOf(priced, prices)).toEqual([
      [ALDRIC, "failed"],
      [ALDRIC, "completed"],
    ]);

    // Ada is retired while she works, so her Task fails; Reassign gives it to Rook, now free, who
    // finishes it from the lead's brief with its history kept.
    const build = taskOf(nested, ADA);
    await run(HobLifecycle.use((lifecycle) => lifecycle.retire(ADA, "stop")));
    await run(treeWhen((tree) => stateOf(tree, build) === "failed"));
    await release();
    await controls((each) => each.reassign(build.id, ROOK));
    const built = await run(
      treeWhen(
        (tree) =>
          stateOf(tree, build) === "completed" &&
          !tree.attempts.some((each) => each.taskId === build.id && isLive(each.state)),
      ),
    );
    expect(attemptsOf(built, build)).toEqual([
      [ADA, "interrupted"],
      [ROOK, "completed"],
    ]);
    expect(built.tasks.find((task) => task.id === build.id)).toMatchObject({
      ownerId: ROOK,
      result: { summary: "Campaign built" },
    });

    // Cancel Quest stops Quill's turn and confirms every Task still open; nothing starts after it.
    const quest = built.quests[0];
    if (quest === undefined) throw new Error("no Quest");
    await controls((each) => each.cancelQuest(quest.id));
    const ended = await run(settledTree((tree) => tree.tasks[0]?.state === "cancelled"));
    expect(ended.quests.map((each) => each.state)).toEqual(["cancelled", "cancelled"]);
    const images = taskOf(ended, QUILL);
    expect(attemptsOf(ended, images)).toEqual([[QUILL, "cancelled"]]);
    expect(new Map(ended.tasks.map((task) => [task.id, task.state]))).toEqual(
      new Map([
        [ended.tasks[0]?.id, "cancelled"],
        [prices.id, "completed"],
        [build.id, "completed"],
        [rook.id, "cancelled"],
        [images.id, "cancelled"],
        [pip.id, "cancelled"],
      ]),
    );
    const sent = script.requests.length;
    await run(Effect.sleep("300 millis"));
    expect(script.requests).toHaveLength(sent);
    await run(nothingOpen);
  }, 60_000);
});

describe("a hub that stops mid-Quest", () => {
  // covers EX-004, OR-002, IN-002, IN-004
  it("[TC-OR-172] starts again with nothing lost or duplicated: the cut-off member works again, your answer and the hand-off arrive once, and the Quest completes", async () => {
    const database = await sharedDatabase();
    const first = await start(database);
    await first.run(
      send([
        "Plan the Black Friday campaign",
        hub("delegate_task", {
          key: "copy",
          hob: "Quill",
          brief: ["Draft the landing copy", HOLD_STARTED].join("\n"),
        }),
        hub("delegate_task", {
          key: "build",
          hob: "Ada",
          brief: [
            "Build the campaign once the copy exists",
            hub("ask", { key: "date", question: "Launch on Dec 12 for international shoppers?" }),
          ].join("\n"),
          depends_on: ["$copy.task_id"],
        }),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id", "$build.task_id"] }),
      ]),
    );
    // Aldric passes Ada's question up to you; Quill's turn is still running when Hobbots stops.
    await first.run(treeWhen((tree) => tree.questions.length === 1));
    await first.run(send(["Ask the user", hub("escalate", { key: "up", question_id: "$date.question_id" })]));
    const before = await first.run(
      treeWhen(
        (tree) =>
          tree.questions[0]?.recipientId === null &&
          memberTask(tree, ADA)?.state === "waiting" &&
          tree.attempts.some((each) => each.agentId === QUILL && each.state === "running") &&
          !tree.attempts.some((each) => each.agentId !== QUILL && isLive(each.state)),
      ),
    );
    // Aldric's turn has settled what it carried, so only Quill's is cut off when Hobbots stops.
    await first.run(settledFor(ALDRIC));
    await first.run(onlyAtWork(QUILL));
    const beforeMessages = await first.run(messagesWhen(() => true));
    const copy = taskOf(before, QUILL);
    const build = taskOf(before, ADA);

    first.stop();

    // The next start, over the same database. Quill goes on in a new turn of his session and returns
    // the copy once let go; Ada finishes once it reaches her through Aldric.
    const second = await start(database, [
      {
        on: `You work on Task ${copy.id} `,
        lines: [
          HOLD,
          hub("complete_task", {
            key: "copy-done",
            summary: "Landing copy ready",
            artifacts: [{ kind: "text", label: "Landing copy", value: "Black Friday: 20% off everything" }],
          }),
        ],
      },
      {
        on: '"Landing copy" was handed to Task',
        lines: [hub("complete_task", { key: "build-done", summary: "Campaign built for Dec 12" })],
      },
    ]);
    const copied = await second.run(
      treeWhen((tree) => tree.attempts.filter((each) => each.taskId === copy.id).length === 2),
    );
    expect(attemptsOf(copied, copy)).toEqual([
      [QUILL, "interrupted"],
      [QUILL, "starting"],
    ]);
    const [quillTurn] = await second.run(
      retry(
        Effect.suspend(() => {
          const sent = promptsTo(second.script.requests, copy);
          return sent.length === 1 ? Effect.succeed(sent) : Effect.fail("not yet" as const);
        }),
      ),
    );
    expect(quillTurn?.sessionId).toBe(before.attempts.find((each) => each.taskId === copy.id)?.sessionId);
    // Nothing of the Quest was lost: the same Tasks, Quest and question, still waiting for you.
    expect(copied.tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id));
    expect(copied.quests.map((quest) => quest.id)).toEqual(before.quests.map((quest) => quest.id));
    expect(copied.delegations.map((each) => each.id)).toEqual(before.delegations.map((each) => each.id));
    const [question] = copied.questions;
    expect(question).toMatchObject({ id: before.questions[0]?.id, state: "open", recipientId: null, chain: [ALDRIC] });
    if (question === undefined) throw new Error("no question");

    await second.run(QuestionService.use((questions) => questions.answer(question.id, "Yes, Dec 12")));
    const answered = await second.run(
      treeWhen(() => promptsTo(second.script.requests, build).length === 1).pipe(Effect.andThen(settledFor(ADA))),
    );
    expect(memberTask(answered, ADA)?.state).toBe("waiting");
    expect(memberTask(answered, QUILL)?.state).toBe("active");
    await second.release();
    const ready = await second.run(treeWhen((tree) => memberTask(tree, QUILL)?.state === "completed"));
    expect(memberTask(ready, ADA)?.state).not.toBe("completed");
    const artifact = ready.artifacts.find((each) => each.label === "Landing copy");
    await second.run(
      send(["Hand the copy to Ada", hub("hand_off", { key: "hand", artifact_id: artifact?.id, to_task_id: build.id })]),
    );
    await second.run(settledTree((tree) => memberTask(tree, ADA)?.state === "completed"));
    await second.run(
      send(["Wrap up", hub("complete_task", { key: "wrap", summary: "The Black Friday campaign is ready" })]),
    );
    const done = await second.run(settledTree((tree) => tree.tasks[0]?.state === "completed"));

    // Nothing was duplicated: one of each record, and each arrival reached Ada once.
    expect(done.tasks.map((task) => [task.ownerId, task.state])).toEqual([
      [ALDRIC, "completed"],
      [QUILL, "completed"],
      [ADA, "completed"],
    ]);
    expect(done.quests.map((quest) => quest.state)).toEqual(["completed"]);
    expect(done.delegations).toHaveLength(2);
    expect(done.questions.map((each) => [each.state, each.answeredBy])).toEqual([["answered", { _tag: "User" }]]);
    expect(done.handOffs.map((each) => each.toTaskId)).toEqual([build.id]);
    expect(attemptsOf(done, build)).toEqual([
      [ADA, "completed"],
      [ADA, "completed"],
      [ADA, "completed"],
    ]);
    const adaPrompts = [...first.script.requests, ...second.script.requests].filter((request) =>
      promptsTo([request], build).includes(request),
    );
    expect(adaPrompts).toHaveLength(3);
    expect(adaPrompts[1]?.prompt).toContain('was answered by the user: "Yes, Dec 12"');
    expect(adaPrompts[2]?.prompt).toContain("Black Friday: 20% off everything");
    expect(attemptsOf(done, copy)).toEqual([
      [QUILL, "interrupted"],
      [QUILL, "completed"],
    ]);
    // Quill's brief was never sent again: his new turn went on in his session from what reached him.
    const quillBriefs = [...first.script.requests, ...second.script.requests].filter((request) =>
      request.prompt.startsWith("Draft the landing copy"),
    );
    expect(quillBriefs).toHaveLength(1);
    // Your messages are kept once each, and every reply ended.
    const all = await second.run(messagesWhen(() => true));
    expect(all.slice(0, beforeMessages.length).map((m) => m.id)).toEqual(beforeMessages.map((m) => m.id));
    expect(all.filter((m) => m.role === "user").map((m) => m.content.split("\n")[0])).toEqual([
      "Plan the Black Friday campaign",
      "Ask the user",
      "Hand the copy to Ada",
      "Wrap up",
    ]);
    expect(await second.run(TaskRepository.use((tasks) => tasks.listLiveAttempts))).toEqual([]);
    await second.run(nothingOpen);
  }, 60_000);

  // covers PE-007, EX-004, OR-001
  it("[TC-PE-263] a This Task grant still covers Aldric's push after the restart, never Quill's, and ends with the Quest", async () => {
    const database = await sharedDatabase();
    const first = await start(database);
    // Aldric brings in Quill, whose turn is still running when Hobbots stops; then he pushes.
    await first.run(
      send([
        "Plan the launch",
        hub("delegate_task", { key: "copy", hob: "Quill", brief: ["Draft the copy", HOLD_STARTED].join("\n") }),
      ]),
    );
    await first.run(messagesWhen((all) => all.length === 2));
    await first.run(send(["Push the branch", push]));
    const request = await first.run(pendingFrom(ALDRIC));
    const [tree] = await first.run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)));
    const top = tree?.tasks[0];
    expect(request).toMatchObject({ rootTaskId: top?.id, grantable: true });
    await first.run(
      ApprovalService.use((approvals) =>
        approvals.decide(request.id, { decision: "approve", actionDigest: request.actionDigest, lifetime: "task" }),
      ),
    );
    await first.run(messagesWhen((all) => all.length === 4));
    if (top === undefined) throw new Error("no Task");

    // Hobbots stops while Quill works. Next start: Aldric pushes again without asking you.
    const second = await start(database, [{ on: `You work on Task `, lines: [push] }]);
    await second.run(send(["Push again", push]));
    const asked = () => second.run(ApprovalService.use((approvals) => approvals.listForThread(threadId)));
    expect((await asked()).filter((each) => each.agentId === ALDRIC).map((each) => each.id)).toEqual([request.id]);
    const [grant] = await second.run(GrantService.use((grants) => grants.list({ agentId: ALDRIC })));
    expect(grant).toMatchObject({ lifetime: "task", taskId: top.id });
    expect(grant?.lastUsedAt).not.toBeNull();

    // Quill's same push, in his turn after the restart, asks you: the grant is Aldric's.
    const quills = await second.run(pendingFrom(QUILL));
    expect(quills).toMatchObject({ agentId: QUILL, rootTaskId: top.id });

    // Cancelling the Quest ends the top Task, and the grant with it.
    const quest = (await second.run(treeWhen((each) => each.quests.length === 1))).quests[0];
    if (quest === undefined) throw new Error("no Quest");
    await second.run(TaskControls.use((controls) => controls.cancelQuest(quest.id)));
    await second.run(settledTree((each) => each.tasks[0]?.state === "cancelled"));
    const [ended] = await second.run(GrantService.use((grants) => grants.list({ agentId: ALDRIC, all: true })));
    expect(ended).toMatchObject({ taskId: top.id, revokedBy: "hub", revokeReason: "task-ended" });
    expect(await second.run(GrantService.use((grants) => grants.live(ALDRIC)))).toEqual([]);
  }, 60_000);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalRepository,
  ApprovalService,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  QuestionService,
  RuntimeAdapter,
  TaskRepository,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type ApprovalRequest,
  AttemptId,
  type BackpackItem,
  type Committed,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  EMPTY_HOB_POLICY,
  type Message,
  NoteId,
  QuestId,
  type Task,
  TaskId,
  type TaskTree,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Backpack, Dispatcher } from "@hobbots/inbox";
import {
  DEFAULT_TASK_TOOL_LIMITS,
  StepRunnerLive,
  TaskSignal,
  type TaskToolLimits,
  TaskTools,
} from "@hobbots/orchestration";
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
import { Deferred, Effect, Layer, ManagedRuntime, Option, Queue, Schedule, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #273: a lead brings in a party, each member works in its own session under its own policy
// narrowed by the delegation, results move between members only through the lead, and the lead
// wraps up in your chat. The fake runtime scripts every hob's calls; nobody prompts after the first
// message.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-quests-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
mkdirSync(project, { recursive: true });

const now = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const ROOK = AgentId.make("rook");
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("campaign");
/** A prompt with this line of its own waits, before it does anything, until the test lets it go on. */
const HOLD = "fake:hold";

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

/** What the hub answered each scripted call, by the call's key: what the hob read back. */
type Answers = Map<string, string>;

/** The request with its hub calls' answers kept in `answers`. */
const answering = (request: PromptRequest, answers: Answers): PromptRequest => {
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

const held = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>, answers: Answers) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (sent) => {
          const request = answering(sent, answers);
          requests.push(request);
          const stream = fake.sendPrompt(request);
          return request.prompt.split("\n").includes(HOLD)
            ? Stream.unwrap(Effect.as(Deferred.await(gate), stream))
            : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

const Party = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const party = [hob(ALDRIC, "Aldric"), hob(QUILL, "Quill"), hob(ADA, "Ada"), hob(ROOK, "Rook"), hob(PIP, "Pip")];
    for (const each of party) yield* repo.insertAgent(each);
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: ALDRIC, title: "Black Friday", createdAt: now, updatedAt: now }),
    );
  }),
);

/** How many rounds the member and step runners have been woken for, across the file. */
let rounds = 0;

/** The hub's Task signal, counting each wake the runners take. */
const CountedSignal = Layer.effect(
  TaskSignal,
  Effect.map(Queue.sliding<void>(1), (queue) =>
    TaskSignal.of({
      notify: Queue.offer(queue, undefined).pipe(Effect.asVoid),
      next: Queue.take(queue).pipe(Effect.tap(() => Effect.sync(() => rounds++))),
    }),
  ),
);

const makeApp = (
  gate: Deferred.Deferred<void>,
  requests: Array<PromptRequest>,
  answers: Answers,
  limits?: TaskToolLimits,
) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(ContinuationsLive),
    Layer.provideMerge(
      StepRunnerLive().pipe(
        Layer.provideMerge(MemberContinuationsLive),
        Layer.provideMerge(TaskTools.layer("/", limits)),
        Layer.provideMerge(CountedSignal),
      ),
    ),
    Layer.provideMerge(Dispatcher.layer().pipe(Layer.provideMerge(DispatcherHostLive))),
    Layer.provideMerge(Layer.mergeAll(ApprovalService.layer, QuestionService.layer)),
    Layer.provideMerge(Party),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        ApprovalRepositoryLive,
        BackpackLive,
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        ProjectTools,
        HobAdmission.layer,
        held(gate, requests, answers),
        Layer.succeed(UserSession, {
          deviceId: WINDOW_DEVICE_ID,
          name: "This computer's Hobbots window",
          kind: "window",
          whileApproved: (write) => write,
        }),
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

const setUp = (limits?: TaskToolLimits) => {
  const requests: Array<PromptRequest> = [];
  const answers: Answers = new Map();
  const gate = Deferred.makeUnsafe<void>();
  const app = ManagedRuntime.make(makeApp(gate, requests, answers, limits));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  return { run, requests, answers, release: () => run(Deferred.succeed(gate, undefined)) };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 800 }));

const isLive = (state: string) => state === "starting" || state === "running";

/** The states of a hob's Attempts in the tree, oldest first. */
const attemptStates = (tree: TaskTree, agentId: AgentId) =>
  tree.attempts.filter((each) => each.agentId === agentId).map((each) => each.state);

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

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

const ownedBy = (tree: TaskTree, agentId: AgentId): Task | undefined =>
  tree.tasks.find((task) => task.ownerId === agentId && task.parentId !== null);

/** The prompts a hob's sessions were sent: its brief, then what arrived for it. */
const promptsTo = (requests: ReadonlyArray<PromptRequest>, task: Task | undefined) =>
  task === undefined
    ? []
    : requests.filter(
        (request) =>
          request.prompt.endsWith(`Task id: ${task.id}.`) ||
          (request.prompt.split("\n\n").at(-1) ?? "").startsWith(`You work on Task ${task.id} `),
      );

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

/** Both members started side by side: Ada's first turn ended while Quill's was still held open. */
const expectBothStarted = (waiting: TaskTree, requests: ReadonlyArray<PromptRequest>) => {
  const quillTask = ownedBy(waiting, QUILL);
  const adaTask = ownedBy(waiting, ADA);
  expect(attemptStates(waiting, QUILL).filter(isLive)).not.toEqual([]);
  expect(attemptStates(waiting, ADA)).toContain("completed");
  expect(adaTask?.dependsOn).toEqual([quillTask?.id]);
  expect(waiting.tasks[0]?.state).toBe("waiting");
  expect(waiting.delegations.map((each) => each.memberId).sort()).toEqual([ADA, QUILL].sort());
  const [adaFirst] = promptsTo(requests, adaTask);
  expect(adaFirst?.sessionId).toBeNull();
  expect(adaFirst?.prompt).toContain("Aldric gave you this Task as part of a Quest Aldric leads.");
  // Quill's Task is queued or already active, whichever runner reached its Task first.
  expect(adaFirst?.prompt).toMatch(new RegExp(`Task ${quillTask?.id}, (queued|active): Draft the landing copy`));
  expect(adaFirst?.prompt).not.toContain("20% off everything");
  const [quillFirst] = promptsTo(requests, quillTask);
  expect(quillFirst?.prompt).toContain("Aldric expects back: Three headlines and a short body");
  return { quillTask, adaTask };
};

/** Ada's second turn got Quill's copy from Aldric and went on in the same session. */
const expectAdaResumed = (done: TaskTree, requests: ReadonlyArray<PromptRequest>, adaTask: Task | undefined) => {
  const adaPrompts = promptsTo(requests, adaTask);
  expect(adaPrompts).toHaveLength(2);
  expect(adaPrompts[1]?.prompt).toContain('"Landing copy" was handed to Task');
  expect(adaPrompts[1]?.prompt).toContain("Black Friday: 20% off everything");
  const adaAttempts = done.attempts.filter((each) => each.taskId === adaTask?.id);
  expect(adaAttempts.map((each) => each.state)).toEqual(["completed", "completed"]);
  expect(adaPrompts[1]?.sessionId).toBe(adaAttempts[0]?.sessionId);
};

describe("leading a party on a Quest", () => {
  // covers OR-002, OR-003, IN-004
  it("[TC-OR-090] Aldric delegates to Quill and Ada in parallel; Ada waits on Quill's copy and gets it through Aldric, who wraps up in the chat", async () => {
    const { run, requests, release } = setUp();
    const prompt = [
      "Plan the Black Friday campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the landing copy",
          HOLD,
          hub("complete_task", {
            key: "copy-done",
            summary: "Landing copy ready",
            artifacts: [{ kind: "text", label: "Landing copy", value: "Black Friday: 20% off everything" }],
          }),
        ].join("\n"),
        expected_output: "Three headlines and a short body",
      }),
      hub("delegate_task", {
        key: "build",
        hob: "Ada",
        brief: [
          "Build the campaign once the copy exists",
          hub("report_checkpoint", { key: "research", kind: "progress", summary: "Keyword research done" }),
        ].join("\n"),
        depends_on: ["$copy.task_id"],
      }),
      hub("wait_for", { key: "wait", tasks: ["$copy.task_id", "$build.task_id"] }),
      // Aldric's next turn answers you; the two after it are the continuations that work arriving starts.
      `fake:then fake:then ${hub("hand_off", { key: "hand", artifact_id: "$copy-done.artifacts.0", to_task_id: "$build.task_id" })}`,
      `fake:then fake:then fake:then ${hub("complete_task", { key: "wrap", summary: "The Black Friday campaign is ready" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    // Both members start at once. Ada works while she waits on Quill's copy, which she never gets
    // from Quill himself; her Task waits.
    const waiting = await run(
      treeWhen((tree) => {
        const quill = ownedBy(tree, QUILL);
        return ownedBy(tree, ADA)?.state === "waiting" && quill?.state === "active" && tree.quests.length === 1;
      }),
    );
    const { quillTask, adaTask } = expectBothStarted(waiting, requests);

    // Aldric waits without blocking his chat: you still get an answer from him.
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, "How is it going?")));
    const chatted = await run(messagesWhen((all) => all.length === 4));
    expect(chatted.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    // Quill finishes; Aldric hands his copy to Ada, who finishes in her own session; Aldric wraps up.
    await release();
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(done.tasks[0]?.result?.summary).toBe("The Black Friday campaign is ready");
    expect(ownedBy(done, QUILL)?.state).toBe("completed");
    expect(ownedBy(done, ADA)?.state).toBe("completed");
    expect(done.handOffs.map((each) => each.toTaskId)).toEqual([adaTask?.id]);

    expectAdaResumed(done, requests, adaTask);

    // Two continuations in the chat: the hand-off, then the wrap-up with the Quest's result.
    const all = await run(messagesWhen((each) => continuations(each).length === 2));
    const [handing, wrapUp] = continuations(all);
    expect(handing?.content).toContain("hand_off: Handed Landing copy to Task");
    expect(wrapUp?.content).toContain(`finished. Its result:`);
    expect(wrapUp?.content).toContain("complete_task: Task");
    // Nothing is left for anyone to deal with, routine progress included: Ada's reached Aldric as a
    // digest along his next turns (#293), and what the wrap-up carries resolves once it has ended.
    for (const agentId of [ALDRIC, QUILL, ADA]) {
      const open = await run(
        retry(
          Effect.flatMap(
            Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId })),
            (items) => (items.length === 0 ? Effect.succeed(items) : Effect.fail("not yet" as const)),
          ),
        ),
      );
      expect(open).toEqual([]);
    }
    const digested = requests.filter((request) =>
      `${request.briefing ?? ""}${request.prompt}`.includes("Routine progress"),
    );
    expect(digested.map((request) => request.prompt)).toContain("How is it going?");
  }, 20_000);

  // covers OR-003, IN-005
  it("[TC-OR-091] a member whose turn ends with its milestones unreported is blocked, and its lead hears of it", async () => {
    const { run } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", { key: "copy", hob: "Quill", brief: "Draft the copy", milestones: ["Headlines"] }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "blocked"));
    const quill = ownedBy(tree, QUILL);
    const blocker = tree.checkpoints.find((each) => each.taskId === quill?.id && each.kind === "blocker");
    expect(blocker?.summary).toContain('milestone "Headlines" is not reached');
    // The blocker and the Failure reach Aldric as continuations in your chat.
    const all = await run(
      messagesWhen((each) => continuations(each).some((reply) => reply.content.includes("ended as blocked."))),
    );
    expect(continuations(all).some((reply) => reply.content.includes("A blocker was reported on Task"))).toBe(true);
  }, 20_000);
});

describe("a retired party member", () => {
  // covers OR-002
  it("[TC-OR-092] a member retired while it works fails its Task with a blocker that says why, and its lead hears of it", async () => {
    const { run } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", { key: "copy", hob: "Quill", brief: ["Draft the copy", HOLD].join("\n") }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    await run(treeWhen((each) => each.attempts.some((attempt) => attempt.agentId === QUILL)));

    await run(HobLifecycle.use((lifecycle) => lifecycle.retire(QUILL, "stop")));

    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "failed"));
    const quill = ownedBy(tree, QUILL);
    const blocker = tree.checkpoints.find((each) => each.taskId === quill?.id && each.kind === "blocker");
    expect(blocker?.summary).toContain("retired");
    expect(tree.attempts.find((each) => each.taskId === quill?.id)?.state).toBe("interrupted");
    await run(messagesWhen((each) => continuations(each).some((reply) => reply.content.includes("ended as failed."))));
  }, 20_000);
});

/** Quill's Task under a Quest Aldric leads, with an Attempt started from outside a session, as the fake Quest starts its party. */
const heldMemberTask = Effect.gen(function* () {
  const lifecycle = yield* HobLifecycle;
  // Quill sleeps while it is set up, so its runner cannot reach the Task before the Attempt holds it.
  yield* lifecycle.pause(QUILL);
  const tasks = yield* TaskRepository;
  const bus = yield* EventBus;
  const at = () => new Date().toISOString();
  const announce = <A>(committed: Committed<A>) => Effect.as(bus.publish(committed.entries), committed.value);
  const attemptOn = (task: Task, id: string) =>
    tasks
      .startAttempt(task.id, task.revision, {
        id: AttemptId.make(id),
        runtime: "claude-code",
        sessionId: null,
        configVersion: 1,
        policyVersion: null,
        startedAt: at(),
      })
      .pipe(Effect.flatMap(announce));
  const lead = yield* tasks
    .createTask({
      task: {
        id: TaskId.make("held-lead"),
        ownerId: ALDRIC,
        parentId: null,
        threadId,
        brief: "Plan the campaign",
        dependsOn: [],
        createdAt: at(),
      },
      delegation: null,
      milestones: [],
    })
    .pipe(Effect.flatMap(announce));
  yield* attemptOn(lead, "held-a-lead");
  yield* tasks
    .startQuest({
      id: QuestId.make("held-quest"),
      taskId: lead.id,
      goal: "A campaign",
      acceptance: [],
      limits: DEFAULT_QUEST_LIMITS,
      createdAt: at(),
    })
    .pipe(Effect.flatMap(announce));
  const task = yield* tasks
    .createTask({
      task: {
        id: TaskId.make("held-copy"),
        ownerId: QUILL,
        parentId: lead.id,
        threadId: null,
        brief: "Draft the copy",
        dependsOn: [],
        createdAt: at(),
      },
      delegation: {
        id: DelegationId.make("held-d-copy"),
        brief: "Draft the copy",
        expectedOutput: null,
        authority: { overrides: {}, folders: null },
        timeoutMs: null,
      },
      milestones: [],
    })
    .pipe(Effect.flatMap(announce));
  const held = (yield* attemptOn(task, "held-a-copy")).task;
  yield* lifecycle.wake(QUILL);
  return held;
});

const QUILL_SCOPE = { _tag: "Hob", agentId: QUILL } as const;

/** Quill's open item about the Task, once it is recorded. */
const itemOn = (taskId: TaskId) =>
  retry(
    Effect.flatMap(
      Backpack.use((backpack) => backpack.listOpen(QUILL_SCOPE)),
      (open) => {
        const found = open.find((item) => item.taskId === taskId);
        return found === undefined ? Effect.fail("not yet" as const) : Effect.succeed(found);
      },
    ),
  );

/** Quill's item is still waiting, untried, after a second: no session took the Task or started a turn for it. */
const expectStillHeld = async (
  run: ReturnType<typeof setUp>["run"],
  requests: ReadonlyArray<PromptRequest>,
  task: Task,
  itemId: BackpackItem["id"],
) => {
  const before = rounds;
  await run(Effect.sleep("1 second"));
  // Waiting is quiet: the member runner is not woken again and again for work it cannot start.
  expect(rounds - before).toBeLessThan(5);
  const tree = Option.getOrThrow(await run(TaskRepository.use((tasks) => tasks.readTree(task.id))));
  expect(tree.tasks[0]?.state).toBe("active");
  expect(tree.attempts.map((each) => each.id)).toEqual(["held-a-copy"]);
  expect(tree.checkpoints.filter((each) => each.kind === "blocker")).toEqual([]);
  expect(await run(Backpack.use((backpack) => backpack.listBlocked(QUILL_SCOPE)))).toEqual([]);
  const item = await run(Backpack.use((backpack) => backpack.find(itemId)));
  expect(item.state).toBe("pending");
  expect(item.deliveries).toEqual([]);
  expect(promptsTo(requests, task)).toEqual([]);
};

describe("a member Task already being worked", () => {
  // covers IN-003
  it("[TC-OR-152] a member Task whose Attempt runs elsewhere keeps its work pending, spends no tries and raises no blocker, and the work settles once the Task ends", async () => {
    const { run, requests } = setUp();
    const memberTask = await run(heldMemberTask);
    const waiting = await run(itemOn(memberTask.id));
    await expectStillHeld(run, requests, memberTask, waiting.id);

    // The Attempt that held it finishes the Task and carries what waited for Quill: no session starts.
    await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const bus = yield* EventBus;
        const current = Option.getOrThrow(yield* tasks.readTree(memberTask.id)).tasks[0];
        const ledger = Option.getOrThrow(yield* tasks.readLedger(memberTask.id));
        const done = yield* tasks.completeTask(memberTask.id, current?.revision ?? 0, {
          summary: "Copy drafted",
          attemptId: AttemptId.make("held-a-copy"),
          artifacts: [],
          at: new Date().toISOString(),
          carried: carriedFrom(ledger, () => true),
        });
        yield* bus.publish(done.entries);
      }),
    );
    const settled = await run(
      retry(
        Effect.flatMap(
          Backpack.use((backpack) => backpack.find(waiting.id)),
          (item) => (item.state === "resolved" ? Effect.succeed(item) : Effect.fail("not yet" as const)),
        ),
      ),
    );
    expect(settled.disposition).toEqual({ _tag: "consumed", by: "attempt:held-a-copy" });
    expect(promptsTo(requests, memberTask)).toEqual([]);
  }, 20_000);

  // covers IN-003
  it("[TC-OR-153] once the Attempt that held a member Task ends without finishing it, the member's own session takes up the work", async () => {
    const { run, requests } = setUp();
    const memberTask = await run(heldMemberTask);
    const waiting = await run(itemOn(memberTask.id));
    await expectStillHeld(run, requests, memberTask, waiting.id);

    // Only the Attempt ends: no backpack item changes, and that alone wakes Quill for the Task.
    await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const bus = yield* EventBus;
        const ended = yield* tasks.updateAttempt(AttemptId.make("held-a-copy"), {
          state: "interrupted",
          outcome: "Stopped elsewhere.",
          at: new Date().toISOString(),
        });
        yield* bus.publish(ended.entries);
      }),
    );
    const resumed = await run(
      retry(
        Effect.flatMap(
          Effect.map(
            TaskRepository.use((tasks) => tasks.readTree(memberTask.id)),
            Option.getOrThrow,
          ),
          (tree) =>
            tree.attempts.some((each) => each.id !== "held-a-copy")
              ? Effect.succeed(tree)
              : Effect.fail("not yet" as const),
        ),
      ),
    );
    expect(resumed.attempts.filter((each) => each.agentId === QUILL).length).toBeGreaterThan(1);
    expect(promptsTo(requests, memberTask).length).toBeGreaterThan(0);
    const taken = await run(Backpack.use((backpack) => backpack.find(waiting.id)));
    expect(taken.deliveries.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("a party member's authority", () => {
  // covers PE-004, PE-006
  it("[TC-PE-160] a member's call that the delegation narrows to Ask asks you in the lead's thread, and runs once you approve", async () => {
    const { run } = setUp();
    const file = join(project, "copy.md");
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Write the copy to a file",
          `fake:tool Write ${file}`,
          hub("complete_task", { key: "copy-done", summary: "Copy written" }),
        ].join("\n"),
        authority: { decisions: { "edit-files": "ask" } },
      }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    // Balanced lets Quill edit on his own; the delegation made it ask, and it asks you, not Aldric.
    const pending = await run(
      retry(
        Effect.flatMap(
          ApprovalRepository.use((approvals) => approvals.listPending),
          (all): Effect.Effect<ApprovalRequest, "not yet"> =>
            all[0] === undefined ? Effect.fail("not yet") : Effect.succeed(all[0]),
        ),
      ),
    );
    expect(pending.agentId).toBe(QUILL);
    expect(pending.threadId).toBe(threadId);
    expect(pending.operation).toBe("edit-files");
    expect(pending.targets).toEqual([file]);
    // It is Quill's request on his own Task, not one of Aldric's messages.
    const asked = await run(treeWhen((each) => ownedBy(each, QUILL) !== undefined));
    expect(pending.messageId).toBeNull();
    expect(pending.taskId).toBe(ownedBy(asked, QUILL)?.id);

    await run(
      ApprovalService.use((approvals) =>
        approvals.decide(pending.id, { decision: "approve", actionDigest: pending.actionDigest }),
      ),
    );
    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "completed"));
    const quill = ownedBy(tree, QUILL);
    expect(quill?.result?.summary).toBe("Copy written");
    // The call ran: it was recorded on Quill's Task before it ran (EX-004).
    expect(tree.checkpoints.some((each) => each.taskId === quill?.id && each.summary.includes("copy.md"))).toBe(true);
    const decided = await run(ApprovalService.use((approvals) => approvals.get(pending.id)));
    expect(decided.state).toBe("approved");
    expect(Option.isSome(Option.fromNullishOr(decided.decidedAt))).toBe(true);
  }, 20_000);

  it("[TC-PE-162] a member only reaches the folders its delegation gives it, even where its own policy reaches further", async () => {
    const { run } = setUp();
    const given = join(project, "copy");
    mkdirSync(given, { recursive: true });
    const inside = join(given, "draft.md");
    const outside = join(project, "secrets.md");
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Write the copy",
          `fake:tool Write ${inside}`,
          `fake:tool Write ${outside}`,
          hub("complete_task", { key: "copy-done", summary: "Copy written" }),
        ].join("\n"),
        authority: { folders: [given] },
      }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "completed"));
    const quill = ownedBy(tree, QUILL);
    const ran = (path: string) =>
      tree.checkpoints.some(
        (each) => each.taskId === quill?.id && each.summary.includes(path.split("/").pop() ?? path),
      );
    // Balanced lets Quill edit the whole project; the delegation keeps him to the copy folder.
    expect(ran(inside)).toBe(true);
    expect(ran(outside)).toBe(false);
    expect(await run(ApprovalRepository.use((approvals) => approvals.listPending))).toEqual([]);
  }, 20_000);

  it("[TC-PE-163] a step a member plans works under the member's delegation too: its folders and its decisions", async () => {
    const { run } = setUp();
    const given = join(project, "steps");
    mkdirSync(given, { recursive: true });
    const step = [
      `fake:tool Read ${join(given, "outline.md")}`,
      `fake:tool Read ${join(project, "budget.md")}`,
      `fake:tool Write ${join(given, "notes.md")}`,
    ].join("\n");
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: ["Write the copy in steps", hub("plan_steps", { key: "plan", steps: [{ brief: step }] })].join("\n"),
        authority: { folders: [given], decisions: { "edit-files": "deny" } },
      }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    const tree = await run(
      treeWhen((each) => {
        const quill = ownedBy(each, QUILL);
        const steps = each.tasks.filter((task) => task.parentId === quill?.id);
        return steps.length === 1 && steps.every((task) => task.state === "completed");
      }),
    );
    const quill = ownedBy(tree, QUILL);
    const stepTask = tree.tasks.find((task) => task.parentId === quill?.id);
    const ran = (file: string) =>
      tree.checkpoints.some((each) => each.taskId === stepTask?.id && each.summary.includes(file));
    // Balanced lets Quill read and edit the whole project; his delegation keeps his step to its
    // folder and takes editing away, as it does for Quill himself.
    expect(ran("outline.md")).toBe(true);
    expect(ran("budget.md")).toBe(false);
    expect(ran("notes.md")).toBe(false);
  }, 20_000);
});

// Issue #274: a member's question climbs to its nearest lead, who answers it or passes it up; one
// no lead can answer reaches you, and every answer goes back down to the hob that asked.

/** The questions in the request's tree once `ready` holds for them. */
const questionsWhen = (ready: (tree: TaskTree) => boolean) =>
  treeWhen(ready).pipe(Effect.map((tree) => tree.questions));

describe("questions in a party", () => {
  // covers OR-002, IN-004
  it("[TC-OR-130] Quill's question reaches Aldric, who answers it himself; it never reaches you and Quill goes on with the answer", async () => {
    const { run, requests } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the copy",
          hub("ask", { key: "tone", question: "Playful or formal?" }),
          `fake:then ${hub("complete_task", { key: "copy-done", summary: "Playful copy drafted" })}`,
        ].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
      // Aldric's next turn is the one Quill's question starts; the one after it, Quill's result.
      `fake:then ${hub("answer", { key: "reply", question_id: "$tone.question_id", answer: "Playful" })}`,
      `fake:then fake:then ${hub("complete_task", { key: "wrap", summary: "Campaign planned" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const quill = ownedBy(done, QUILL);
    expect(quill?.result?.summary).toBe("Playful copy drafted");
    const [question] = done.questions;
    expect(question?.askerId).toBe(QUILL);
    expect(question?.chain).toEqual([]);
    expect(question?.answeredBy).toEqual({ _tag: "Lead", agentId: ALDRIC });
    expect(question?.answer).toBe("Playful");

    // Aldric heard the question in a continuation of his chat and was told how to answer it.
    const all = await run(messagesWhen((each) => continuations(each).length === 2));
    const [asked] = continuations(all);
    expect(asked?.content).toContain(`question ${question?.id} about Task ${quill?.id}`);
    expect(asked?.content).toContain("Playful or formal?");
    expect(asked?.content).toContain("pass it up with escalate");
    expect(asked?.content).toContain("answer: Answered");
    // Quill's next turn went on in his own session with Aldric's answer.
    const quillPrompts = promptsTo(requests, quill);
    expect(quillPrompts).toHaveLength(2);
    expect(quillPrompts[1]?.prompt).toContain('was answered by hob aldric: "Playful"');
    expect(quillPrompts[1]?.sessionId).not.toBeNull();
  }, 20_000);

  // covers OR-002, IN-002, IN-004
  it("[TC-OR-131] Ada's question that Aldric passes up reaches you, and your answer goes back down to her", async () => {
    const { run, requests } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "build",
        hob: "Ada",
        brief: [
          "Build the campaign",
          hub("ask", { key: "date", question: "Dec 12 for international?" }),
          `fake:then ${hub("complete_task", { key: "build-done", summary: "Built for Dec 12" })}`,
        ].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$build.task_id"] }),
      `fake:then ${hub("escalate", { key: "up", question_id: "$date.question_id" })}`,
      `fake:then fake:then ${hub("complete_task", { key: "wrap", summary: "Campaign built" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    // Aldric passed it up: no lead is left, so it waits for you.
    const [waiting] = await run(questionsWhen((tree) => tree.questions[0]?.recipientId === null));
    expect(waiting?.chain).toEqual([ALDRIC]);
    expect(waiting?.state).toBe("open");
    // Once Aldric's turn that passed it up ends, nothing in any hob's backpack waits on it: it is yours.
    await run(
      retry(
        Effect.flatMap(
          Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: ALDRIC })),
          (items) =>
            items.some((item) => item.payload._tag === "question") ? Effect.fail("not yet" as const) : Effect.void,
        ),
      ),
    );

    if (waiting === undefined) throw new Error("no question");
    await run(QuestionService.use((questions) => questions.answer(waiting.id, "Yes, Dec 12")));

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const ada = ownedBy(done, ADA);
    expect(ada?.result?.summary).toBe("Built for Dec 12");
    expect(done.questions[0]?.answeredBy).toEqual({ _tag: "User" });
    const adaPrompts = promptsTo(requests, ada);
    expect(adaPrompts).toHaveLength(2);
    expect(adaPrompts[1]?.prompt).toContain('was answered by the user: "Yes, Dec 12"');
  }, 20_000);
});

describe("what reaches a lead", () => {
  // covers OR-002, IN-004
  it("[TC-OR-132] your note on Quill's Task reaches Aldric as a message about that Task, once, however often it is sent", async () => {
    const { run, release } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", { key: "copy", hob: "Quill", brief: ["Draft the copy", HOLD].join("\n") }),
      hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    const started = await run(treeWhen((tree) => ownedBy(tree, QUILL) !== undefined));
    const quill = ownedBy(started, QUILL);
    if (quill === undefined) throw new Error("no Task for Quill");

    const key = NoteId.make("note-1");
    const leave = () => run(QuestionService.use((notes) => notes.leaveNote(quill.id, key, "Keep it short")));
    const note = await leave();
    expect(note.recipientId).toBe(ALDRIC);
    // Sent again, as a client retrying would, it is the same note and goes nowhere twice.
    expect(await leave()).toEqual(note);
    const reused = await run(
      QuestionService.use((notes) => notes.leaveNote(quill.id, key, "Make it long")).pipe(Effect.flip),
    );
    expect(reused._tag).toBe("NoteRefused");

    const all = await run(
      messagesWhen((each) => continuations(each).some((reply) => reply.content.includes("The user left a note"))),
    );
    const noted = continuations(all).filter((reply) => reply.content.includes("The user left a note"));
    expect(noted).toHaveLength(1);
    expect(noted[0]?.content).toContain(`The user left a note about Task ${quill.id}: Keep it short`);
    const tree = await run(treeWhen((each) => each.notes.length > 0));
    expect(tree.notes.map((each) => each.text)).toEqual(["Keep it short"]);
    // Quill never hears it from you: his session holds nothing of it.
    const quillItems = await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: QUILL })));
    expect(quillItems.filter((item) => item.payload._tag === "message")).toEqual([]);
    await release();
  }, 20_000);

  // covers OR-003, IN-005
  it("[TC-OR-133] Quill's finding wakes Aldric with his routine progress folded in; the progress alone never does", async () => {
    const { run } = setUp();
    const progress = (n: number) => hub("report_checkpoint", { key: `p${n}`, kind: "progress", summary: `Draft ${n}` });
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the copy",
          progress(1),
          progress(2),
          progress(3),
          hub("report_checkpoint", { key: "found", kind: "finding", summary: "The brand voice changed last week" }),
          hub("complete_task", { key: "copy-done", summary: "Copy drafted" }),
        ].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
      // The finding and the result may arrive in one continuation or two: Aldric wraps up in whichever has both.
      `fake:then ${hub("complete_task", { key: "wrap", summary: "Campaign planned" })}`,
      `fake:then fake:then ${hub("complete_task", { key: "wrap-later", summary: "Campaign planned" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const all = await run(messagesWhen((each) => continuations(each).length >= 1));
    const woken = continuations(all);
    // The finding and the result woke Aldric, at most once each; three updates woke him no more.
    expect(woken.length).toBeGreaterThanOrEqual(1);
    expect(woken.length).toBeLessThanOrEqual(2);
    const finding = woken.find((reply) => reply.content.includes("A finding was reported on Task"));
    expect(finding?.content).toContain("The brand voice changed last week");
    expect(
      woken.every((reply) => !reply.content.includes("Work arrived for you while you were not running:\n\nRoutine")),
    ).toBe(true);
    // Quill's three updates and the hub's own "started" read as one line of the digest.
    const told = woken.map((reply) => reply.content).join("\n");
    expect(told).toContain("sent 4 updates. The latest: Draft 3");
  }, 20_000);
});

// Issue #275: a party member brings in a hob of its own and leads that subtree under the same rules
// the hub holds every lead to. Nesting adds no checks of its own: depth, cycles, the subtree and
// narrowing authority are the ones every call already passes (#271).

/** The Task of the request's tree that `agentId` owns, which the test knows is there. */
const taskOf = (tree: TaskTree, agentId: AgentId): Task => {
  const task = ownedBy(tree, agentId);
  if (task === undefined) throw new Error(`No Task for ${agentId}`);
  return task;
};

/** Aldric brings in Rook with `rookBrief`, waits on him and wraps up once Rook's result is in. */
const aldricLeads = (rookBrief: ReadonlyArray<string>, after: ReadonlyArray<string> = []) =>
  [
    "Plan the Black Friday campaign",
    hub("delegate_task", { key: "ads", hob: "Rook", brief: ["Run the ads", ...rookBrief].join("\n") }),
    hub("wait_for", { key: "wait", tasks: ["$ads.task_id"] }),
    ...after,
    // Rook's result may arrive with his routine progress or after it: Aldric wraps up in whichever turn has it.
    `fake:then ${hub("complete_task", { key: "wrap", summary: "The Black Friday campaign is ready" })}`,
    `fake:then fake:then ${hub("complete_task", { key: "wrap-later", summary: "The Black Friday campaign is ready" })}`,
  ].join("\n");

/** Rook brings in Pip with `pipBrief`, waits on her, and returns his result once hers is in. */
const rookLeads = (pipBrief: ReadonlyArray<string>, after: ReadonlyArray<string> = []) => [
  hub("delegate_task", { key: "keywords", hob: "Pip", brief: ["Research the keywords", ...pipBrief].join("\n") }),
  hub("wait_for", { key: "rook-wait", tasks: ["$keywords.task_id"] }),
  ...after,
];

/** The three levels of the tree, each under the one above, with a Quest on Aldric's Task and one on Rook's. */
const expectNested = (tree: TaskTree) => {
  const [top] = tree.tasks;
  const rook = taskOf(tree, ROOK);
  const pip = taskOf(tree, PIP);
  expect(rook.parentId).toBe(top?.id);
  expect(pip.parentId).toBe(rook.id);
  expect(pip.rootId).toBe(top?.id);
  expect(tree.quests.map((quest) => [quest.taskId, quest.leadId, quest.depth])).toEqual([
    [top?.id, ALDRIC, 1],
    [rook.id, ROOK, 2],
  ]);
  expect(tree.delegations.map((each) => [each.leadId, each.memberId, each.childTaskId])).toEqual([
    [ALDRIC, ROOK, rook.id],
    [ROOK, PIP, pip.id],
  ]);
  return { rook, pip };
};

describe("a nested Quest", () => {
  // covers OR-002, OR-004
  it("[TC-OR-160] Rook brings in Pip under Aldric's Quest and leads her: her result reaches Rook, and the tree holds all three", async () => {
    const { run, requests } = setUp();
    const pipBrief = [hub("complete_task", { key: "keywords-done", summary: "Twelve keywords, led by 'doorbuster'" })];
    const rookBrief = rookLeads(pipBrief, [
      `fake:then ${hub("complete_task", { key: "ads-done", summary: "Ads ready around 'doorbuster'" })}`,
    ]);
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, aldricLeads(rookBrief))));

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const { rook, pip } = expectNested(done);
    expect(done.tasks.map((task) => task.state)).toEqual(["completed", "completed", "completed"]);
    expect(pip.result?.summary).toBe("Twelve keywords, led by 'doorbuster'");
    expect(rook.result?.summary).toBe("Ads ready around 'doorbuster'");
    expect(done.quests.map((quest) => quest.state)).toEqual(["completed", "completed"]);

    // Pip deals with Rook, her nearest lead, and never with Aldric.
    const [pipFirst] = promptsTo(requests, pip);
    expect(pipFirst?.prompt).toContain("Rook gave you this Task as part of a Quest Rook leads.");
    expect(pipFirst?.prompt).not.toContain("Aldric");
    // Her result went on in Rook's own session; Aldric heard only Rook's.
    const rookPrompts = promptsTo(requests, rook);
    expect(rookPrompts).toHaveLength(2);
    expect(rookPrompts[1]?.prompt).toContain("Twelve keywords");
    expect(rookPrompts[1]?.sessionId).not.toBeNull();
    const all = await run(messagesWhen((each) => continuations(each).length >= 1));
    const told = continuations(all)
      .map((reply) => reply.content)
      .join("\n");
    expect(told).toContain(`Task ${rook.id}`);
    expect(told).not.toContain("Twelve keywords");
  }, 20_000);

  // covers OR-004
  it("[TC-OR-161] a delegation loop is stopped: Pip cannot bring in a hob past the depth limit, nor anyone above her", async () => {
    const { run, answers } = setUp();
    // Pip tries to go one level deeper and to hand the work back up, then does it herself.
    const pipBrief = [
      hub("delegate_task", { key: "deeper", hob: "Quill", brief: "Research some more" }),
      hub("start_quest", { key: "own-quest", goal: "Bring in more hobs", max_depth: 3 }),
      hub("delegate_task", { key: "to-rook", hob: "Rook", brief: "Your turn" }),
      hub("delegate_task", { key: "to-aldric", hob: "Aldric", brief: "Your turn" }),
      hub("complete_task", { key: "keywords-done", summary: "Researched the keywords myself" }),
    ];
    const rookBrief = rookLeads(pipBrief, [
      hub("delegate_task", { key: "rook-to-aldric", hob: "Aldric", brief: "Back to you" }),
      `fake:then ${hub("complete_task", { key: "ads-done", summary: "Ads ready" })}`,
    ]);
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, aldricLeads(rookBrief))));

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expectNested(done);
    // Nothing was created past Pip: the refused calls wrote nothing.
    expect(done.tasks).toHaveLength(3);
    expect(done.tasks.map((task) => task.state)).toEqual(["completed", "completed", "completed"]);
    expect(answers.get("deeper")).toBe(
      "Refused (depth-limit): This would be a Quest 3 deep, past the limit of 2. Do this work yourself, or split it into steps.",
    );
    expect(answers.get("own-quest")).toMatch(/^Refused \(depth-limit\)/);
    expect(answers.get("to-rook")).toMatch(/^Refused \(cycle\): Rook already owns work this Task is part of/);
    expect(answers.get("to-aldric")).toMatch(/^Refused \(cycle\): Aldric already owns work this Task is part of/);
    expect(answers.get("rook-to-aldric")).toMatch(/^Refused \(cycle\): Aldric already owns work/);
    expect(taskOf(done, PIP).result?.summary).toBe("Researched the keywords myself");
  }, 20_000);

  // covers OR-004
  it("[TC-OR-162] with the depth limit raised, a loop is still stopped: by the cycle check, then by the new limit", async () => {
    const { run, answers } = setUp({ ...DEFAULT_TASK_TOOL_LIMITS, maxDepth: 3 });
    // Quill, a level further down, tries every hob above him, then one more level.
    const quillBrief = [
      "Write the ad copy",
      hub("delegate_task", { key: "q-rook", hob: "Rook", brief: "Your turn" }),
      hub("delegate_task", { key: "q-pip", hob: "Pip", brief: "Your turn" }),
      hub("delegate_task", { key: "q-aldric", hob: "Aldric", brief: "Your turn" }),
      hub("delegate_task", { key: "q-ada", hob: "Ada", brief: "One more level" }),
      hub("complete_task", { key: "copy-done", summary: "Wrote the copy myself" }),
    ].join("\n");
    const pipBrief = [
      hub("delegate_task", { key: "copy", hob: "Quill", brief: quillBrief }),
      hub("wait_for", { key: "pip-wait", tasks: ["$copy.task_id"] }),
    ];
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, aldricLeads(rookLeads(pipBrief)))));

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(done.quests.map((quest) => [quest.leadId, quest.depth])).toEqual([
      [ALDRIC, 1],
      [ROOK, 2],
      [PIP, 3],
    ]);
    expect(done.tasks.map((task) => task.ownerId)).toEqual([ALDRIC, ROOK, PIP, QUILL]);
    for (const [key, name] of [
      ["q-rook", "Rook"],
      ["q-pip", "Pip"],
      ["q-aldric", "Aldric"],
    ]) {
      expect(answers.get(key ?? "")).toMatch(new RegExp(`^Refused \\(cycle\\): ${name} already owns work`));
    }
    expect(answers.get("q-ada")).toMatch(
      /^Refused \(depth-limit\): This would be a Quest 4 deep, past the limit of 3\./,
    );
  }, 20_000);

  // covers OR-002, IN-002, IN-004
  it("[TC-OR-163] Pip's question reaches Rook first, climbs to Aldric and then to you, and your answer goes back down to her", async () => {
    const { run, requests } = setUp();
    const pipBrief = [
      hub("ask", { key: "tone", question: "Playful or formal?" }),
      `fake:then ${hub("complete_task", { key: "keywords-done", summary: "Playful keywords" })}`,
    ];
    // Rook's next turn is the one Pip's question starts; the one after it, Pip's result.
    const rookBrief = rookLeads(pipBrief, [
      `fake:then ${hub("escalate", { key: "rook-up", question_id: "$tone.question_id" })}`,
      `fake:then fake:then ${hub("complete_task", { key: "ads-done", summary: "Playful ads" })}`,
    ]);
    const aldricUp = [`fake:then ${hub("escalate", { key: "aldric-up", question_id: "$tone.question_id" })}`];
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, aldricLeads(rookBrief, aldricUp))));

    // Rook passed it up and so did Aldric: no lead is left, so it waits for you.
    const [waiting] = await run(questionsWhen((tree) => tree.questions[0]?.recipientId === null));
    expect(waiting?.askerId).toBe(PIP);
    expect(waiting?.chain).toEqual([ROOK, ALDRIC]);
    const asked = await run(treeWhen(() => true));
    const rook = taskOf(asked, ROOK);
    const pip = taskOf(asked, PIP);
    // Rook heard it first, in his own session; Aldric only once Rook passed it up.
    const heard = requests.filter((request) => request.prompt.includes(`question ${waiting?.id}`));
    expect(heard.map((request) => (promptsTo([request], rook).length > 0 ? "rook" : "other"))).toEqual([
      "rook",
      "other",
    ]);
    expect(heard[0]?.sessionId).not.toBeNull();
    if (waiting === undefined) throw new Error("no question");
    await run(QuestionService.use((questions) => questions.answer(waiting.id, "Playful")));

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(taskOf(done, PIP).result?.summary).toBe("Playful keywords");
    expect(taskOf(done, ROOK).result?.summary).toBe("Playful ads");
    expect(done.questions[0]?.answeredBy).toEqual({ _tag: "User" });
    const pipPrompts = promptsTo(requests, pip);
    expect(pipPrompts).toHaveLength(2);
    expect(pipPrompts[1]?.prompt).toContain('was answered by the user: "Playful"');
  }, 20_000);
});

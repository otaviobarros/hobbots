import {
  ApprovalRepository,
  ApprovalService,
  ChatService,
  Continuations,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  type BackpackItem,
  CheckpointId,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  Message,
  MessageId,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Backpack, Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
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
import { Deferred, Effect, Layer, ManagedRuntime, Schedule, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// The one wake path of ADR 019: work that arrives for a hob whose turn has ended starts a
// continuation in its thread, with the fake runtime scripting what that turn does.

const now = "2026-11-02T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
/** A chat prompt with this line keeps its turn running until the test lets it end. */
const HOLD = "fake:hold";

/** Whether continuations wait for the gate before they write. */
let holdContinuations = false;
/** A prompt whose turn waits for the gate before it writes, so it can be stopped. */
let holdPrompt: string | null = null;

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
          // A continuation, while held, waits before it writes anything, so it can be stopped.
          if ((holdContinuations && request.prompt.startsWith("Hobbots wrote this")) || request.prompt === holdPrompt) {
            return Stream.unwrap(Effect.as(Deferred.await(gate), stream));
          }
          return request.prompt.includes(HOLD)
            ? stream.pipe(Stream.concat(Stream.fromEffect(Deferred.await(gate)).pipe(Stream.drain)))
            : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

/** Holds the next dispatch that finds no work before the chat frees its thread, until `proceed`. */
let emptyDispatch: { readonly reached: Deferred.Deferred<void>; readonly proceed: Deferred.Deferred<void> } | null =
  null;
/** Dispatches that have returned so far. */
let dispatches = 0;

const observed = Layer.effect(
  Continuations,
  Effect.gen(function* () {
    const live = yield* Continuations;
    return Continuations.of({
      ...live,
      deliver: (threadId, agentId, turn) =>
        live.deliver(threadId, agentId, turn).pipe(
          Effect.tap((ran) => {
            dispatches += 1;
            const gate = emptyDispatch;
            if (ran || gate === null) return Effect.void;
            emptyDispatch = null;
            return Deferred.succeed(gate.reached, undefined).pipe(Effect.andThen(Deferred.await(gate.proceed)));
          }),
        ),
    });
  }),
).pipe(Layer.provide(ContinuationsLive));

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));

/** What the hub's records hold before it starts, as after a restart. */
type Before = Layer.Layer<never, never, HobbotsRepository | TaskRepository | ApprovalRepository>;

const makeApp = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>, before: Before) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(observed.pipe(Layer.provideMerge(Dispatcher.layer()), Layer.provideMerge(DispatcherHostLive))),
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(ApprovalService.layer),
    Layer.provideMerge(before),
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
        NoTools,
        HobAdmission.layer,
        held(gate, requests),
      ),
    ),
    Layer.provideMerge(TestDatabase),
  );

type App = ReturnType<typeof makeApp>;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<App>, Layer.Error<App>> | undefined;

afterEach(async () => {
  holdContinuations = false;
  holdPrompt = null;
  emptyDispatch = null;
  dispatches = 0;
  await runtime?.dispose();
  runtime = undefined;
});

const frodo = new Agent({
  id: FRODO,
  name: "Frodo",
  roleTitle: "Ring-bearer",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 1,
  lookColor: "moss",
  configVersion: 1,
  createdAt: now,
});
const threadId = ThreadId.make("shire");

/** Frodo and his thread, stored before the hub starts. */
const Frodo: Before = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(frodo);
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
    );
  }),
);

const setUp = (before: Before = Frodo) => {
  const requests: Array<PromptRequest> = [];
  const gate = Deferred.makeUnsafe<void>();
  const app = ManagedRuntime.make(makeApp(gate, requests, before));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  return { run, requests, release: () => run(Deferred.succeed(gate, undefined)) };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }));

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

/** Frodo's backpack items, settled or not. */
const itemsOf = (ids: ReadonlyArray<BackpackItem["id"]>) =>
  Effect.forEach(ids, (id) => Backpack.use((b) => b.find(id)));

/** The items once every one of them is resolved or failed. */
const settledItems = (ids: ReadonlyArray<BackpackItem["id"]>) =>
  retry(
    Effect.flatMap(itemsOf(ids), (items) =>
      items.every((each) => each.state === "resolved" || each.state === "failed")
        ? Effect.succeed(items)
        : Effect.fail("not yet" as const),
    ),
  );

/** Frodo's Task with one step, which fails: returns the Failure that arrives for Frodo. */
const failedStep = Effect.gen(function* () {
  const tasks = yield* TaskRepository;
  const task = (id: string, parentId: string | null) => ({
    id: TaskId.make(id),
    ownerId: FRODO,
    parentId: parentId === null ? null : TaskId.make(parentId),
    threadId,
    brief: `Brief for ${id}`,
    dependsOn: [],
    createdAt: now,
  });
  yield* tasks.createTask({ task: task("quest", null), delegation: null, milestones: [] });
  const step = yield* tasks.createTask({ task: task("pass", "quest"), delegation: null, milestones: [] });
  const failed = yield* tasks.moveTask(step.value.id, step.value.revision, "failed", now);
  const entry = failed.entries.find((each) => each.payload._tag === "BackpackItemRecorded");
  return entry?.payload._tag === "BackpackItemRecorded" ? entry.payload.item : undefined;
});

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

describe("continuing a hob when work arrives", () => {
  // covers IN-004, EX-003
  it("[TC-OR-080] a step's result that arrives after the turn ended starts a continuation, which completes the Task", async () => {
    const { run, requests } = setUp();
    // Frodo plans one step, and scripts what his next turn does: return the Task's result.
    const prompt = [
      "Carry the ring to Mordor",
      hub("plan_steps", { key: "plan", steps: [{ brief: "Walk to Mordor" }] }),
      `fake:then ${hub("complete_task", { key: "done", summary: "The ring is destroyed" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    // Nobody writes again: the step's result wakes Frodo, and his continuation completes the Task.
    const tree = await run(
      retry(
        Effect.gen(function* () {
          const [found] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
          return found?.tasks[0]?.state === "completed" ? found : yield* Effect.fail("not yet" as const);
        }),
      ),
    );
    expect(tree.tasks[0]?.result?.summary).toBe("The ring is destroyed");
    const all = await run(messagesWhen((each) => each.length === 3));
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(continuations(all)).toHaveLength(1);
    const [continuation] = continuations(all);
    expect(continuation?.content).toContain("complete_task: ");

    // Its prompt was Hobbots' own, naming what arrived, in the thread's session.
    const asked = requests.find((request) => request.prompt.startsWith("Hobbots wrote this, not the user."));
    expect(asked?.prompt).toContain("finished. Its result:");
    expect(asked?.sessionId).not.toBeNull();

    // The result it carried was consumed by the Task's completion, under the dispatcher's claim.
    const open = await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: FRODO })));
    expect(open.filter((item) => item.actionable)).toEqual([]);
  });

  // covers IN-004, CH-008
  it("[TC-OR-081] your queued message starts first after a busy turn, and the work rides along it as context", async () => {
    const { run, requests, release } = setUp();
    await run(
      ChatService.use((chat) =>
        chat.sendPrompt(
          threadId,
          ["Carry the ring", HOLD, hub("plan_steps", { key: "plan", steps: [{ brief: "Walk" }] })].join("\n"),
        ),
      ),
    );
    // The step finishes while Frodo's turn still runs: its result waits for that turn to end.
    const waiting = await run(
      retry(
        Effect.gen(function* () {
          const open = yield* Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: FRODO }));
          const results = open.filter((item) => item.kind === "result");
          return results.length === 1 ? results : yield* Effect.fail("not yet" as const);
        }),
      ),
    );
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, "Where are we?")));
    await release();

    const all = await run(messagesWhen((each) => each.length === 4));
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(all[2]?.content).toBe("Where are we?");
    expect(continuations(all)).toEqual([]);
    const answered = requests.find((request) => request.prompt === "Where are we?");
    expect(answered?.briefing).toContain("Hobbots adds this, not the user.");
    expect(answered?.briefing).toContain("finished. Its result:");
    // The item resolves once the turn has ended, just after its reply is saved.
    const [item] = await run(settledItems(waiting.map((each) => each.id)));
    expect(item?.disposition).toEqual({ _tag: "consumed", by: all[3]?.id });
  });

  // covers IN-004, AG-006
  it("[TC-OR-082] a paused hob keeps what arrived, and the continuation starts once it wakes", async () => {
    const { run } = setUp();
    await run(HobLifecycle.use((hobs) => hobs.pause(FRODO)));
    // A step of Frodo's Task fails while he is paused: its Failure is his to read.
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    expect(failure.kind).toBe("failure");
    const id = failure.id;

    // Paused, nothing starts and the item stays pending.
    await run(Effect.sleep("150 millis"));
    expect(await run(messages())).toEqual([]);
    expect((await run(itemsOf([id])))[0]?.state).toBe("pending");

    await run(HobLifecycle.use((hobs) => hobs.wake(FRODO)));
    const all = await run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.role).toBe("assistant");
    expect(all[0]?.content).toContain("ended as failed.");
    const [settled] = await run(settledItems([id]));
    expect(settled?.disposition).toEqual({ _tag: "consumed", by: all[0]?.id });
  });

  // covers IN-004, PE-007
  it("[TC-OR-083] a request that expired when Hobbots restarted reaches its hob as a continuation", async () => {
    const pending = new ApprovalRequest({
      id: ApprovalId.make("push"),
      agentId: FRODO,
      threadId,
      messageId: MessageId.make("before-restart"),
      stepId: "tool-1",
      tool: "Bash",
      operation: "push",
      targets: ["origin main"],
      arguments: { command: "git push origin main" },
      label: "Running git push origin main",
      reason: "Pushing asks first.",
      actionDigest: "d".repeat(64),
      policyVersion: "r1",
      onceOnly: false,
      state: "pending",
      denyReason: null,
      createdAt: now,
      decidedAt: null,
    });
    const { run } = setUp(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const repo = yield* HobbotsRepository;
          yield* repo.insertAgent(frodo);
          yield* repo.upsertThread(
            new Thread({ id: threadId, agentId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
          );
          // The reply that asked was still running when Hobbots stopped.
          yield* repo.upsertMessage(
            new Message({
              id: pending.messageId,
              threadId,
              role: "assistant",
              content: "Pushing the ring's map",
              status: "streaming",
              error: null,
              configVersion: 1,
              createdAt: now,
            }),
          );
          yield* ApprovalRepository.use((approvals) => approvals.insert(pending));
        }),
      ),
    );
    // The reply that asked was interrupted by the restart; the continuation follows it.
    const all = await run(messagesWhen((each) => each.length === 2));
    expect(all[0]?.status).toBe("interrupted");
    expect(all[1]?.content).toContain('The approval you asked for, "Running git push origin main", ended as expired.');
    expect(all[1]?.content).toContain("That tool call never ran.");
    expect((await run(ApprovalService.use((approvals) => approvals.get(pending.id)))).state).toBe("expired");
  });
  // covers IN-004, CH-008
  it("[TC-OR-084] a continuation you stop does not start again on its own, and its work rides along your next message", async () => {
    holdContinuations = true;
    const { run, requests, release } = setUp();
    const prompt = ["Carry the ring", hub("plan_steps", { key: "plan", steps: [{ brief: "Walk" }] })].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    // The step's result starts a continuation, which you stop before it writes.
    const started = await run(
      retry(
        Effect.gen(function* () {
          const all = yield* messages();
          const last = all.at(-1);
          const asked = requests.some((request) => request.prompt.startsWith("Hobbots wrote this"));
          return asked && all.length === 3 && last?.status === "streaming"
            ? last
            : yield* Effect.fail("not yet" as const);
        }),
      ),
    );
    await run(ChatService.use((chat) => chat.stop(threadId)));
    await run(messagesWhen((all) => all.at(-1)?.status === "stopped"));
    await release();

    // Nothing starts again: the work waits, pending, for you, and the thread is idle once the
    // dispatch that the stop ended has returned.
    await run(retry(Effect.suspend(() => (dispatches > 0 ? Effect.void : Effect.fail("not yet" as const)))));
    await run(Effect.sleep("300 millis"));
    const after = await run(messages());
    expect(after.map((m) => m.status)).toEqual(["complete", "complete", "stopped"]);
    expect(after[2]?.id).toBe(started.id);
    const [waiting] = await run(
      Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: FRODO })).pipe(
        Effect.map((open) => open.filter((item) => item.kind === "result")),
      ),
    );
    expect(waiting?.state).toBe("pending");

    // Your next message takes it along, and its turn consumes it: no second continuation starts.
    const sent = await run(ChatService.use((chat) => chat.sendPrompt(threadId, "Go on")));
    // It starts through the dispatcher, which puts the work into its turn.
    expect(sent.assistantMessage).toBeNull();
    const all = await run(messagesWhen((each) => each.length === 5));
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    expect(all[4]?.content).toContain("Hobbots adds this, not the user.");
    const [settled] = await run(settledItems(waiting === undefined ? [] : [waiting.id]));
    expect(settled?.disposition).toEqual({ _tag: "consumed", by: all[4]?.id });
    expect(requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"))).toHaveLength(1);
  }, 10_000);
  // covers IN-004
  it("[TC-OR-085] work that arrives while a wake finds nothing still starts once the thread is free", async () => {
    const reached = Deferred.makeUnsafe<void>();
    const proceed = Deferred.makeUnsafe<void>();
    emptyDispatch = { reached, proceed };
    const { run } = setUp();
    // A wake finds nothing waiting, and the thread is not yet free again.
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(Deferred.await(reached));

    // A step of Frodo's Task fails now: its Failure arrives, and its wake finds the thread busy.
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(Deferred.succeed(proceed, undefined));

    // Freed, the thread looks again: the Failure starts its continuation.
    const all = await run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.content).toContain("ended as failed.");
    const [settled] = await run(settledItems([failure.id]));
    expect(settled?.disposition).toEqual({ _tag: "consumed", by: all[0]?.id });
  });
});

const SAM = AgentId.make("sam");

/** Frodo and his thread, and Sam, who works a Task under Frodo's: stored before the hub starts. */
const FrodoAndSam: Before = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Layer.build(Frodo).pipe(Effect.scoped);
    yield* HobbotsRepository.use((repo) =>
      repo.insertAgent(new Agent({ ...frodo, id: SAM, name: "Sam", roleTitle: "Gardener", lookSeed: 2 })),
    );
  }),
);

/** Frodo's Task, and Sam's Task under it: Sam's routine progress is Frodo's to hear. */
const samsTask = Effect.gen(function* () {
  const tasks = yield* TaskRepository;
  const task = (id: string, ownerId: AgentId, parentId: string | null) => ({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    threadId,
    brief: `Brief for ${id}`,
    dependsOn: [],
    createdAt: now,
  });
  const quest = yield* tasks.createTask({ task: task("quest", FRODO, null), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("supper"),
    taskId: quest.value.id,
    goal: "Supper on the road",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  const delegation = {
    id: DelegationId.make("d-cook"),
    brief: "Cook the stew",
    expectedOutput: null,
    authority: { overrides: {}, folders: null },
    timeoutMs: null,
  };
  return (yield* tasks.createTask({ task: task("cook", SAM, "quest"), delegation, milestones: [] })).value;
});

/** Sam reports `count` routine progress updates on his Task: returns the items they made for Frodo. */
const reportProgress = (count: number) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const items: Array<BackpackItem> = [];
    for (let index = 1; index <= count; index++) {
      const reported = yield* tasks.recordCheckpoint({
        id: CheckpointId.make(`progress-${index}`),
        taskId: TaskId.make("cook"),
        source: "unplanned",
        kind: "progress",
        milestoneId: null,
        summary: `Stirred ${index} times`,
        createdAt: now,
      });
      for (const entry of reported.entries) {
        if (entry.payload._tag === "BackpackItemRecorded") items.push(entry.payload.item);
      }
    }
    return items;
  });

describe("coalescing routine progress", () => {
  // covers IN-005
  it("[TC-OR-100] thirty progress updates start no turn, and reach the lead as one digest in the continuation work starts", async () => {
    const { run, requests } = setUp(FrodoAndSam);
    const cook = await run(samsTask);
    const progress = await run(reportProgress(30));
    expect(progress).toHaveLength(30);
    expect(progress.every((item) => item.recipientId === FRODO && !item.actionable)).toBe(true);

    // Even woken, Frodo's thread starts nothing for progress alone: it waits, pending.
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(retry(Effect.suspend(() => (dispatches > 0 ? Effect.void : Effect.fail("not yet" as const)))));
    await run(Effect.sleep("150 millis"));
    expect(await run(messages())).toEqual([]);
    expect((await run(itemsOf(progress.map((item) => item.id)))).every((item) => item.state === "pending")).toBe(true);

    // Sam's Task fails: that is actionable, and starts one continuation carrying the progress too.
    await run(TaskRepository.use((tasks) => tasks.moveTask(cook.id, cook.revision, "failed", now)));
    // A repository write here announces nothing, so the test wakes the thread as its announcement would.
    await run(ChatService.use((chat) => chat.wake(threadId)));
    const all = await run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.content).toContain("ended as failed.");
    const asked = requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain("Routine progress since your last turn, 30 updates in all.");
    expect(asked[0]?.prompt).toContain("- Task cook sent 30 updates. The latest: Stirred 30 times");
    expect(asked[0]?.prompt).not.toContain("Stirred 29 times");

    // The one turn consumed every update along with the Failure.
    const settled = await run(settledItems(progress.map((item) => item.id)));
    expect(settled.every((item) => item.disposition?._tag === "consumed")).toBe(true);
    await run(Effect.sleep("150 millis"));
    expect(requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"))).toHaveLength(1);
  }, 10_000);

  // covers IN-005, CH-008
  it("[TC-OR-101] progress that piled up rides along your next message as one digest, and that turn consumes it", async () => {
    const { run, requests } = setUp(FrodoAndSam);
    await run(samsTask);
    const progress = await run(reportProgress(3));

    const sent = await run(ChatService.use((chat) => chat.sendPrompt(threadId, "How is Sam doing?")));
    // It starts through the dispatcher, which puts the progress into its turn.
    expect(sent.assistantMessage).toBeNull();
    const all = await run(messagesWhen((each) => each.length === 2));
    expect(all.map((m) => m.role)).toEqual(["user", "assistant"]);
    const answered = requests.find((request) => request.prompt === "How is Sam doing?");
    expect(answered?.briefing).toContain("Routine progress since your last turn, 3 updates in all.");
    expect(answered?.briefing).toContain("Use this progress only as context.");
    expect(requests.some((request) => request.prompt.startsWith("Hobbots wrote this"))).toBe(false);
    const settled = await run(settledItems(progress.map((item) => item.id)));
    expect(settled.map((item) => item.disposition)).toEqual(progress.map(() => ({ _tag: "consumed", by: all[1]?.id })));
  });

  // covers IN-005, CH-008
  it("[TC-OR-102] a turn that carried only progress and ended early holds nothing back, and the progress never runs out of deliveries", async () => {
    const { run, requests, release } = setUp(FrodoAndSam);
    const cook = await run(samsTask);
    const progress = await run(reportProgress(2));

    // Three of your messages are cut off, each carrying the progress: it goes back to pending every time.
    for (let round = 1; round <= 3; round++) {
      await run(ChatService.use((chat) => chat.sendPrompt(threadId, `fake:cut-off try ${round}`)));
      await run(messagesWhen((each) => each.length === round * 2));
    }
    const after = await run(
      retry(
        Effect.flatMap(itemsOf(progress.map((item) => item.id)), (items) =>
          items.every((item) => item.state === "pending" && item.deliveries.length === 3)
            ? Effect.succeed(items)
            : Effect.fail("not yet" as const),
        ),
      ),
    );
    expect(after.every((item) => item.error === null)).toBe(true);

    // You stop the next one: that holds back nothing, so work that needs Frodo still starts at once.
    holdPrompt = "Stew?";
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, "Stew?")));
    await run(
      retry(
        Effect.flatMap(messages(), (all) =>
          all.length === 8 && all.at(-1)?.status === "streaming" ? Effect.void : Effect.fail("not yet" as const),
        ),
      ),
    );
    await run(ChatService.use((chat) => chat.stop(threadId)));
    await run(messagesWhen((all) => all.at(-1)?.status === "stopped"));
    await release();
    await run(TaskRepository.use((tasks) => tasks.moveTask(cook.id, cook.revision, "failed", now)));
    await run(ChatService.use((chat) => chat.wake(threadId)));
    const all = await run(messagesWhen((each) => each.length === 9));
    expect(all[8]?.content).toContain("ended as failed.");
    const asked = requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain("- Task cook sent 2 updates. The latest: Stirred 2 times");
    const settled = await run(settledItems(progress.map((item) => item.id)));
    expect(settled.every((item) => item.disposition?._tag === "consumed")).toBe(true);
  }, 15_000);
});

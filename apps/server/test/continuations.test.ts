import {
  ApprovalRepository,
  ApprovalService,
  type CarriedWork,
  type CarryingTurn,
  ChatService,
  Continuations,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  TaskControls,
  TaskRepository,
  ChannelMemberRepository,
  TurnSlots,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  AttemptId,
  type BackpackItem,
  CheckpointId,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  hobActor,
  IDLE_QUEST,
  Message,
  MessageId,
  OWNER_ACTOR,
  OWNER_USER_ID,
  QuestId,
  TaskId,
  Channel,
  ChannelId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import {
  Backpack,
  DEFAULT_DISPATCH_LIMITS,
  Dispatcher,
  type DispatchLimits,
  decideBlocker,
  RESULT_IN_BRIEFING,
} from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  ChannelMemberRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Layer, ManagedRuntime, Option, Schedule, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { BlockersHostLive, BlockOnRetirement } from "../src/blockers.ts";
import { ContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// The one wake path of ADR 019: work that arrives for a hob whose turn has ended starts a
// continuation in its channel, with the fake runtime scripting what that turn does.

const now = "2026-11-02T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
/** A chat prompt with this line keeps its turn running until the test lets it end. */
const HOLD = "fake:hold";

/** Whether continuations wait for the gate before they write. */
let holdContinuations = false;
/** A prompt whose turn waits for the gate before it writes, so it can be stopped. */
let holdPrompt: string | null = null;
/** Whether continuations are cut off, as a provider that stops responding cuts them. */
let cutContinuations = false;

const held = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          requests.push(request);
          const continuation = request.prompt.includes("Hobbots wrote this");
          const stream = fake.sendPrompt(
            cutContinuations && continuation ? { ...request, prompt: `fake:cut-off\n${request.prompt}` } : request,
          );
          // A continuation, while held, waits before it writes anything, so it can be stopped.
          if ((holdContinuations && continuation) || request.prompt === holdPrompt) {
            return Stream.unwrap(Effect.as(Deferred.await(gate), stream));
          }
          return request.prompt.includes(HOLD)
            ? stream.pipe(Stream.concat(Stream.fromEffect(Deferred.await(gate)).pipe(Stream.drain)))
            : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

/** Holds the next dispatch once it delivered, before the chat frees its line, until `proceed`. */
let finishingDispatch: { readonly reached: Deferred.Deferred<void>; readonly proceed: Deferred.Deferred<void> } | null =
  null;
/** Dispatches that have returned so far. */
let dispatches = 0;

/**
 * Holds the next continuation that runs until `proceed`, once its items are claimed and checked:
 * before the chat starts it (`claimed`), or once the chat has read its work as still due and is
 * about to save its reply (`checked`). `reached` learns the items it holds, and `settled` is done
 * once its dispatch returned.
 */
let holdCarry: {
  readonly at: "claimed" | "checked";
  readonly reached: Deferred.Deferred<ReadonlyArray<BackpackItem["id"]>>;
  readonly proceed: Deferred.Deferred<void>;
  readonly settled: Deferred.Deferred<void>;
} | null = null;

/** `turn`, its first run held as `holdCarry` asks; `wasHeld` tells whether this turn took the gate. */
const holding = (turn: CarryingTurn) => {
  let took: NonNullable<typeof holdCarry> | null = null;
  const hold = (gate: NonNullable<typeof holdCarry>, work: CarriedWork) =>
    Deferred.succeed(
      gate.reached,
      work.holding.map((each) => each.itemId),
    ).pipe(Effect.andThen(Deferred.await(gate.proceed)));
  const held: CarryingTurn = {
    ...turn,
    run: (turnId, work) =>
      Effect.suspend(() => {
        const gate = holdCarry;
        if (gate === null) return turn.run(turnId, work);
        holdCarry = null;
        took = gate;
        if (gate.at === "claimed") return Effect.andThen(hold(gate, work), turn.run(turnId, work));
        let reads = 0;
        const late = Effect.tap(work.late, () => (reads++ === 0 ? hold(gate, work) : Effect.void));
        return turn.run(turnId, { ...work, late });
      }),
  };
  return { turn: held, took: () => took };
};

const observed = Layer.effect(
  Continuations,
  Effect.gen(function* () {
    const live = yield* Continuations;
    return Continuations.of({
      ...live,
      deliver: (channelId, agentId, turn) => {
        const carried = holding(turn);
        return live.deliver(channelId, agentId, carried.turn).pipe(
          Effect.tap(() => {
            dispatches += 1;
            const took = carried.took();
            const settled = took === null ? Effect.void : Deferred.succeed(took.settled, undefined);
            const gate = finishingDispatch;
            if (gate === null) return settled;
            finishingDispatch = null;
            return settled.pipe(
              Effect.andThen(Deferred.succeed(gate.reached, undefined)),
              Effect.andThen(Deferred.await(gate.proceed)),
            );
          }),
        );
      },
    });
  }),
).pipe(Layer.provide(ContinuationsLive));

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));

/** What the hub's records hold before it starts, as after a restart. */
type Before = Layer.Layer<
  never,
  never,
  HobbotsRepository | TaskRepository | ApprovalRepository | ChannelMemberRepository
>;

/** Quick retries, so a test that exhausts them stays short. */
const LIMITS: DispatchLimits = { ...DEFAULT_DISPATCH_LIMITS, firstRetry: "5 millis", maxRetry: "20 millis" };

const makeApp = (
  gate: Deferred.Deferred<void>,
  requests: Array<PromptRequest>,
  before: Before,
  limits: DispatchLimits,
  turnCap: number | null,
) =>
  Layer.mergeAll(WakeOnArrival, BlockOnRetirement, HobLifecycle.layer, TaskControls.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(
      observed.pipe(Layer.provideMerge(Dispatcher.layer(limits)), Layer.provideMerge(DispatcherHostLive)),
    ),
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(ApprovalService.layer),
    Layer.provideMerge(before),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        ChannelMemberRepositoryLive,
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
        turnCap === null ? Layer.empty : TurnSlots.layerWith(turnCap),
        Layer.succeed(UserSession, {
          deviceId: WINDOW_DEVICE_ID,
          name: "This computer's Hobbots window",
          kind: "window",
          userId: OWNER_USER_ID,
          actor: OWNER_ACTOR,
          whileApproved: (write) => write,
        }),
      ),
    ),
    Layer.provideMerge(TestDatabase),
  );

type App = ReturnType<typeof makeApp>;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<App>, Layer.Error<App>> | undefined;

afterEach(async () => {
  holdContinuations = false;
  holdPrompt = null;
  cutContinuations = false;
  finishingDispatch = null;
  holdCarry = null;
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
const channelId = ChannelId.make("shire");

/** Frodo and his channel, stored before the hub starts. */
const Frodo: Before = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(frodo);
    yield* repo.upsertChannel(
      new Channel({ id: channelId, ownerHobId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
    );
  }),
);

const SAM = AgentId.make("sam");

/** Sam's camp, which Frodo joined: Frodo's Tasks run from there. */
const SamsCamp: Before = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(frodo);
    yield* repo.insertAgent(new Agent({ ...frodo, id: SAM, name: "Sam", roleTitle: "Gardener" }));
    yield* repo.upsertChannel(
      new Channel({ id: channelId, ownerHobId: SAM, title: "The quest", kind: "camp", createdAt: now, updatedAt: now }),
    );
    yield* Effect.orDie(ChannelMemberRepository.use((members) => members.add(channelId, hobActor(FRODO), OWNER_ACTOR)));
  }),
);

const setUp = (before: Before = Frodo, limits: DispatchLimits = LIMITS, turnCap: number | null = null) => {
  const requests: Array<PromptRequest> = [];
  const gate = Deferred.makeUnsafe<void>();
  const app = ManagedRuntime.make(makeApp(gate, requests, before, limits, turnCap));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  return { run, requests, release: () => run(Deferred.succeed(gate, undefined)) };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }));

const messages = () => HobbotsRepository.use((repo) => repo.listMessages(channelId));

/**
 * Waits until the channel has nothing running, dispatching or draining, so whatever a wake or a
 * turn's end was going to start has started (STD-TEST-009).
 */
const settledRun = () =>
  retry(
    Effect.gen(function* () {
      const chat = yield* ChatService;
      const { runs } = yield* chat.channelRuns;
      const busy = runs.some((each) => each.channelId === channelId && each.run !== "idle");
      return busy || (yield* chat.activeChannels).includes(channelId) ? yield* Effect.fail("busy" as const) : undefined;
    }),
  );

/** The channel's messages once `ready` holds for them, every reply ended. */
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

/** `owner`'s Task with one step, which fails: returns the Failure that arrives for `owner`. */
const failedStepOf = (owner: AgentId, prefix = "") =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const task = (id: string, parentId: string | null) => ({
      id: TaskId.make(`${prefix}${id}`),
      ownerId: owner,
      parentId: parentId === null ? null : TaskId.make(`${prefix}${parentId}`),
      channelId,
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

/** Frodo's Task with one step, which fails: returns the Failure that arrives for Frodo. */
const failedStep = failedStepOf(FRODO);

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

describe("continuing a hob when work arrives", () => {
  it("a step's result that arrives after the turn ended starts a continuation, which completes the Task", async () => {
    const { run, requests } = setUp();
    // Frodo plans one step, and scripts what his next turn does: return the Task's result.
    const prompt = [
      "Carry the ring to Mordor",
      hub("plan_steps", { key: "plan", steps: [{ brief: "Walk to Mordor" }] }),
      `fake:then ${hub("complete_task", { delivered: true, key: "done", summary: "The ring is destroyed" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(channelId, prompt)));

    // Nobody writes again: the step's result wakes Frodo, and his continuation completes the Task.
    const tree = await run(
      retry(
        Effect.gen(function* () {
          const [found] = yield* TaskRepository.use((tasks) => tasks.readChannelTrees(channelId));
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

    // Its prompt was Hobbots' own, naming what arrived, in the channel's session.
    const asked = requests.find((request) => request.prompt.startsWith("Hobbots wrote this, not the user."));
    expect(asked?.prompt).toContain(`finished. ${RESULT_IN_BRIEFING}`);
    expect(asked?.sessionId).not.toBeNull();

    // The result it carried was consumed by the Task's completion, under the dispatcher's claim.
    const open = await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: FRODO })));
    expect(open.filter((item) => item.actionable)).toEqual([]);
  });

  it("your queued message starts first after a busy turn, and the work rides along it as context", async () => {
    const { run, requests, release } = setUp();
    await run(
      ChatService.use((chat) =>
        chat.sendPrompt(
          channelId,
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
    await run(ChatService.use((chat) => chat.sendPrompt(channelId, "Where are we?")));
    await release();

    const all = await run(messagesWhen((each) => each.length === 4));
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(all[2]?.content).toBe("Where are we?");
    expect(continuations(all)).toEqual([]);
    const answered = requests.find((request) => request.prompt === "Where are we?");
    expect(answered?.briefing).toContain("Hobbots adds this, not the user.");
    expect(answered?.briefing).toContain(`finished. ${RESULT_IN_BRIEFING}`);
    // The item resolves once the turn has ended, just after its reply is saved.
    const [item] = await run(settledItems(waiting.map((each) => each.id)));
    expect(item?.disposition).toEqual({ _tag: "consumed", by: all[3]?.id });
  });

  it("a paused hob keeps what arrived, and the continuation starts once it wakes", async () => {
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

  // covers ADR 039 (One hob speaks at a time)
  it("a member hob's work that arrives in a camp it joined starts its own continuation there once it wakes (#1461)", async () => {
    const { run } = setUp(SamsCamp);
    await run(HobLifecycle.use((hobs) => hobs.pause(FRODO)));
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    // A wake now finds no hob that can carry it: Frodo is paused, and Sam has nothing there.
    await run(ChatService.use((chat) => chat.wake(channelId)));
    await run(settledRun());
    expect(await run(messages())).toEqual([]);

    // Frodo wakes and carries his own work in Sam's camp; Sam's turn never takes it.
    await run(HobLifecycle.use((hobs) => hobs.wake(FRODO)));
    const all = await run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.actor).toMatchObject({ kind: "hob", id: FRODO });
    expect(all[0]?.content).toContain("ended as failed.");
    const [settled] = await run(settledItems([failure.id]));
    expect(settled?.disposition).toEqual({ _tag: "consumed", by: all[0]?.id });
  });

  // covers ADR 039 (One hob speaks at a time)
  it("the oldest request is answered before another hob's work, which then starts (#1461)", async () => {
    const { run, release } = setUp(SamsCamp);
    await run(ChatService.use((chat) => chat.sendPrompt(channelId, ["@sam plan the road", HOLD].join("\n"))));
    // While Sam's turn runs, Frodo's step fails and you ask Sam again.
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    await run(ChatService.use((chat) => chat.sendPrompt(channelId, "@sam where are we?")));
    await release();

    // Sam answers you first, though his dispatch finds no work of his; then Frodo carries his.
    const all = await run(messagesWhen((each) => each.length === 5));
    expect(all.map((m) => [m.role, m.actor?.kind === "hob" ? m.actor.id : null])).toEqual([
      ["user", null],
      ["assistant", SAM],
      ["user", null],
      ["assistant", SAM],
      ["assistant", FRODO],
    ]);
    expect(all[4]?.content).toContain("ended as failed.");
  });

  // covers ADR 039 (One hob speaks at a time)
  it("a member hob's work starts while the camp's own hob, with work of its own there, is paused (#1461)", async () => {
    const { run } = setUp(SamsCamp);
    await run(HobLifecycle.use((hobs) => hobs.pause(SAM)));
    await run(failedStepOf(SAM, "sam-"));
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    // The arrival wakes the camp, as the hub's wake on arrival does.
    await run(ChatService.use((chat) => chat.wake(channelId)));

    const all = await run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.actor).toMatchObject({ kind: "hob", id: FRODO });
    expect(all[0]?.content).toContain("ended as failed.");
  });

  // covers ADR 039 (One hob speaks at a time)
  // Starts Frodo's continuation in Sam's camp and stops it before it writes.
  const stopFrodosContinuation = async (
    run: ReturnType<typeof setUp>["run"],
    release: ReturnType<typeof setUp>["release"],
  ) => {
    holdContinuations = true;
    await run(failedStep);
    await run(ChatService.use((chat) => chat.wake(channelId)));
    // Frodo's continuation starts in Sam's camp, and you stop it before it writes.
    await run(
      retry(
        Effect.flatMap(messages(), (all) =>
          all.at(-1)?.status === "streaming" ? Effect.void : Effect.fail("not yet" as const),
        ),
      ),
    );
    // Once its turn runs, so the stop reaches it.
    await run(
      retry(
        Effect.flatMap(
          ChatService.use((chat) => chat.activeChannels),
          (active) => (active.includes(channelId) ? Effect.void : Effect.fail("not yet" as const)),
        ),
      ),
    );
    await run(ChatService.use((chat) => chat.stop(channelId)));
    await run(messagesWhen((all) => all.at(-1)?.status === "stopped"));
    holdContinuations = false;
    await release();
    await run(settledRun());
    expect((await run(messages())).map((m) => m.status)).toEqual(["stopped"]);
  };

  // covers ADR 039 (One hob speaks at a time)
  it("a member hob's continuation you stop in a camp starts again once that hob wakes (#1461)", async () => {
    const { run, release } = setUp(SamsCamp);
    await stopFrodosContinuation(run, release);

    // Sam waking leaves Frodo's stopped work held; Frodo waking takes it up.
    await run(HobLifecycle.use((hobs) => hobs.pause(SAM).pipe(Effect.andThen(hobs.wake(SAM)))));
    await run(settledRun());
    expect(await run(messages())).toHaveLength(1);
    await run(HobLifecycle.use((hobs) => hobs.pause(FRODO).pipe(Effect.andThen(hobs.wake(FRODO)))));
    const all = await run(messagesWhen((each) => each.length === 2));
    expect(all.map((m) => [m.status, m.actor?.kind === "hob" ? m.actor.id : null])).toEqual([
      ["stopped", FRODO],
      ["complete", FRODO],
    ]);
  });

  // covers ADR 039 (One hob speaks at a time)
  it("another hob's work starts in a camp while the work you stopped stays held (#1461)", async () => {
    const { run, release } = setUp(SamsCamp);
    await stopFrodosContinuation(run, release);

    // Sam's step fails in his camp: his work starts, and Frodo's stays held.
    await run(failedStepOf(SAM, "sam-"));
    await run(ChatService.use((chat) => chat.wake(channelId)));
    const all = await run(messagesWhen((each) => each.length === 2 && each[1]?.status === "complete"));
    expect(all.map((m) => [m.status, m.actor?.kind === "hob" ? m.actor.id : null])).toEqual([
      ["stopped", FRODO],
      ["complete", SAM],
    ]);
    await run(settledRun());
    expect(await run(messages())).toHaveLength(2);
  });

  // covers ADR 039 (One hob speaks at a time)
  it("stopping a second hob's continuation keeps the first hob's stopped work held (#1461)", async () => {
    const { run, release } = setUp(SamsCamp);
    // Stops the continuation that is the camp's latest message once its turn runs.
    const stopLatest = async (count: number) => {
      await run(
        retry(
          Effect.flatMap(messages(), (all) =>
            all.length === count && all.at(-1)?.status === "streaming" ? Effect.void : Effect.fail("not yet" as const),
          ),
        ),
      );
      await run(
        retry(
          Effect.flatMap(
            ChatService.use((chat) => chat.activeChannels),
            (active) => (active.includes(channelId) ? Effect.void : Effect.fail("not yet" as const)),
          ),
        ),
      );
      await run(ChatService.use((chat) => chat.stop(channelId)));
      await run(messagesWhen((all) => all.length === count && all.at(-1)?.status === "stopped"));
    };
    holdContinuations = true;
    await run(failedStep);
    await run(ChatService.use((chat) => chat.wake(channelId)));
    await stopLatest(1);
    // Sam's work starts while Frodo's stays held, and you stop Sam's too.
    await run(failedStepOf(SAM, "sam-"));
    await run(ChatService.use((chat) => chat.wake(channelId)));
    await stopLatest(2);
    holdContinuations = false;
    await release();

    // Neither starts again on its own once Sam's turn has ended.
    await run(settledRun());
    expect((await run(messages())).map((m) => [m.status, m.actor?.kind === "hob" ? m.actor.id : null])).toEqual([
      ["stopped", FRODO],
      ["stopped", SAM],
    ]);
  });

  // covers ADR 039 (One hob speaks at a time)
  it("a member hob retiring once its Tasks end still carries the work of its open Task in a camp (#1461)", async () => {
    const { run } = setUp(SamsCamp);
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    // Frodo's Task is open, so he retires only once it ends.
    expect((await run(HobLifecycle.use((hobs) => hobs.retireWhenDone(FRODO)))).retiring).not.toBeNull();
    await run(ChatService.use((chat) => chat.wake(channelId)));

    const all = await run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.actor).toMatchObject({ kind: "hob", id: FRODO });
    expect(all[0]?.content).toContain("ended as failed.");
  });

  // covers ADR 039 (One hob speaks at a time)
  it("work only a paused member hob can carry waits without dispatching again and again (#1461)", async () => {
    const { run } = setUp(SamsCamp);
    await run(HobLifecycle.use((hobs) => hobs.pause(FRODO)));
    await run(failedStep);
    await run(ChatService.use((chat) => chat.wake(channelId)));
    await run(settledRun());
    // At most the one dispatch the wake started, which found nothing of Sam's.
    expect(dispatches).toBeLessThanOrEqual(1);
    expect(await run(messages())).toEqual([]);
  });

  it("a Quest whose turn ended just before Hobbots stopped, before its wake was recorded, wakes its lead as the hub starts (#1081)", async () => {
    // The records as that stop left them: Frodo's Task leads an active Quest, his turn's Attempt
    // has ended, and nothing is under it, waits or is in his backpack.
    const crashed: Before = Layer.effectDiscard(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* repo.insertAgent(frodo);
        yield* repo.upsertChannel(
          new Channel({ id: channelId, ownerHobId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
        );
        const tasks = yield* TaskRepository;
        const root = yield* tasks.createTask({
          task: {
            id: TaskId.make("ring"),
            ownerId: FRODO,
            parentId: null,
            channelId,
            brief: "Carry the ring to Mordor",
            dependsOn: [],
            createdAt: now,
          },
          delegation: null,
          milestones: [],
        });
        const attemptId = AttemptId.make("ring-1");
        yield* tasks.startAttempt(root.value.id, root.value.revision, {
          id: attemptId,
          runtime: "claude-code",
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: now,
        });
        yield* tasks.startQuest({
          id: QuestId.make("q-ring"),
          taskId: root.value.id,
          goal: "Destroy the ring",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: now,
        });
        yield* tasks.updateAttempt(attemptId, {
          _tag: "Ended",
          end: { _tag: "Finished", outcome: "The turn finished." },
          at: now,
        });
      }).pipe(Effect.orDie),
    );
    const { run, requests } = setUp(crashed);

    // The hub records the wake that turn's end would have, and Frodo's continuation carries it.
    await run(messagesWhen((all) => continuations(all).length > 0));
    const woken = requests.filter((request) => request.prompt.includes(IDLE_QUEST));
    expect(woken).toHaveLength(1);
    expect(woken[0]?.prompt).toContain("Quest q-ring (Destroy the ring)");

    // That turn again leaves the Quest idle: the Task is blocked, and only one wake was recorded.
    const tree = await run(
      retry(
        Effect.flatMap(
          TaskRepository.use((tasks) => tasks.readTree(TaskId.make("ring"))),
          (read) =>
            read._tag === "Some" && read.value.tasks[0]?.state === "blocked"
              ? Effect.succeed(read.value)
              : Effect.fail("not yet" as const),
        ),
      ),
    );
    expect(tree.checkpoints.filter((each) => each.summary === IDLE_QUEST)).toHaveLength(1);
  });

  it("a request that expired when Hobbots restarted reaches its hob as a continuation", async () => {
    const pending = new ApprovalRequest({
      id: ApprovalId.make("push"),
      agentId: FRODO,
      channelId,
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
          yield* repo.upsertChannel(
            new Channel({ id: channelId, ownerHobId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
          );
          // The reply that asked was still running when Hobbots stopped.
          yield* repo.upsertMessage(
            new Message({
              id: MessageId.make("before-restart"),
              channelId,
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
  it("a continuation you stop does not start again on its own, and its work rides along your next message", async () => {
    holdContinuations = true;
    const { run, requests, release } = setUp();
    const prompt = ["Carry the ring", hub("plan_steps", { key: "plan", steps: [{ brief: "Walk" }] })].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(channelId, prompt)));
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
    await run(ChatService.use((chat) => chat.stop(channelId)));
    await run(messagesWhen((all) => all.at(-1)?.status === "stopped"));
    await release();

    // Nothing starts again: the work waits, pending, for you, and the channel is idle once the
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
    const sent = await run(ChatService.use((chat) => chat.sendPrompt(channelId, "Go on")));
    // It starts through the dispatcher, which puts the work into its turn.
    expect(sent.assistantMessage).toBeNull();
    const all = await run(messagesWhen((each) => each.length === 5));
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    expect(all[4]?.content).toContain("Hobbots adds this, not the user.");
    const [settled] = await run(settledItems(waiting === undefined ? [] : [waiting.id]));
    expect(settled?.disposition).toEqual({ _tag: "consumed", by: all[4]?.id });
    expect(requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"))).toHaveLength(1);
  }, 10_000);
  it("work that arrives while a dispatch is finishing still starts once the line is free", async () => {
    const reached = Deferred.makeUnsafe<void>();
    const proceed = Deferred.makeUnsafe<void>();
    finishingDispatch = { reached, proceed };
    const { run } = setUp();
    // A step fails: its continuation runs, and its dispatch has not yet freed the line.
    await run(failedStep);
    await run(ChatService.use((chat) => chat.wake(channelId)));
    await run(Deferred.await(reached));

    // A step of another Task of Frodo's fails now: its Failure arrives, and its wake finds the line busy.
    const failure = await run(failedStepOf(FRODO, "later-"));
    if (failure === undefined) throw new Error("no Failure recorded");
    await run(ChatService.use((chat) => chat.wake(channelId)));
    await run(Deferred.succeed(proceed, undefined));

    // Freed, the line looks again: the second Failure starts a continuation of its own.
    const [settled] = await run(settledItems([failure.id]));
    const all = await run(messages());
    const consumedBy = all.find((m) => settled?.disposition?._tag === "consumed" && m.id === settled.disposition.by);
    expect(consumedBy?.role).toBe("assistant");
    expect(consumedBy?.content).toContain("ended as failed.");
  });

  /**
   * Frodo plans one step and scripts his next turn to plan another. The step's result is claimed
   * for a continuation, which `holdCarry` holds at `at`; you cancel the request meanwhile. Returns
   * the items the continuation held, and the channel's messages once it settled.
   */
  const cancelWhileHeld = async (at: "claimed" | "checked") => {
    const reached = Deferred.makeUnsafe<ReadonlyArray<BackpackItem["id"]>>();
    const proceed = Deferred.makeUnsafe<void>();
    const settled = Deferred.makeUnsafe<void>();
    holdCarry = { at, reached, proceed, settled };
    const { run, requests } = setUp();
    const prompt = [
      "Carry the ring",
      hub("plan_steps", { key: "plan", steps: [{ brief: "Walk" }] }),
      `fake:then ${hub("plan_steps", { key: "again", steps: [{ brief: "Walk again" }] })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(channelId, prompt)));
    const held = await run(Deferred.await(reached));
    const [tree] = await run(TaskRepository.use((tasks) => tasks.readChannelTrees(channelId)));
    const top = tree?.tasks[0];
    if (top === undefined) throw new Error("no Task");
    await run(TaskControls.use((controls) => controls.cancel(top.id)));
    await run(
      retry(
        Effect.gen(function* () {
          const [now] = yield* TaskRepository.use((tasks) => tasks.readChannelTrees(channelId));
          return now?.tasks[0]?.state === "cancelled" ? undefined : yield* Effect.fail("not yet" as const);
        }),
      ),
    );
    await run(Deferred.succeed(proceed, undefined));

    // The work resolves as late. Once its dispatch returned, the line goes idle: nothing more was
    // asked of the runtime or started.
    const items = await run(settledItems(held));
    expect(items.map((item) => item.disposition?._tag)).toEqual(held.map(() => "late"));
    await run(Deferred.await(settled));
    await run(settledRun());
    expect(await run(ChatService.use((chat) => chat.activeChannels))).toEqual([]);
    expect(requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"))).toEqual([]);
    const trees = await run(TaskRepository.use((tasks) => tasks.readChannelTrees(channelId)));
    expect(trees.map((each) => each.tasks.map((task) => [task.brief.split("\n")[0], task.state]))).toEqual([
      [
        ["Carry the ring", "cancelled"],
        ["Walk", "completed"],
      ],
    ]);
    return { held, all: await run(messages()) };
  };

  it("a continuation claimed before you cancel its request never starts: its work resolves as late, and no runtime request goes out", async () => {
    const { held, all } = await cancelWhileHeld("claimed");
    expect(held).toHaveLength(1);
    expect(all.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
  });

  it("a continuation you cancel the request of as it starts ends stopped before its runtime is asked, and starts no Task in its place", async () => {
    const { all } = await cancelWhileHeld("checked");
    expect(all.map((m) => [m.role, m.status, m.content])).toEqual([
      ["user", "complete", expect.any(String)],
      ["assistant", "complete", expect.any(String)],
      ["assistant", "stopped", ""],
    ]);
  });
});

/** Frodo and his channel, and Sam, who works a Task under Frodo's: stored before the hub starts. */
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
    channelId,
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
  it("thirty progress updates start no turn, and reach the lead as one digest in the continuation work starts", async () => {
    const { run, requests } = setUp(FrodoAndSam);
    const cook = await run(samsTask);
    const progress = await run(reportProgress(30));
    expect(progress).toHaveLength(30);
    expect(progress.every((item) => item.recipientId === FRODO && !item.actionable)).toBe(true);

    // Even woken, Frodo's channel starts nothing for progress alone, not even a dispatch: it waits, pending.
    // The wake decides the floor before it returns, so a dispatch it started would show here already.
    await run(ChatService.use((chat) => chat.wake(channelId)));
    const { runs } = await run(ChatService.use((chat) => chat.channelRuns));
    expect(runs.filter((each) => each.channelId === channelId && each.run !== "idle")).toEqual([]);
    expect(dispatches).toBe(0);
    expect(await run(messages())).toEqual([]);
    expect((await run(itemsOf(progress.map((item) => item.id)))).every((item) => item.state === "pending")).toBe(true);

    // Sam's Task fails: that is actionable, and starts one continuation carrying the progress too.
    await run(TaskRepository.use((tasks) => tasks.moveTask(cook.id, cook.revision, "failed", now)));
    // A repository write here announces nothing, so the test wakes the channel as its announcement would.
    await run(ChatService.use((chat) => chat.wake(channelId)));
    const all = await run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.content).toContain("ended as failed.");
    // Frodo's reply does nothing about the failure, so the hub then wakes him once about his idle
    // Quest (#1081): that turn is not about the progress, and carries none of it.
    const continued = () => requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"));
    const asked = continued().filter((request) => !request.prompt.includes(IDLE_QUEST));
    expect(asked).toHaveLength(1);
    expect(continued().every((request) => request === asked[0] || !request.prompt.includes("Routine progress"))).toBe(
      true,
    );
    expect(asked[0]?.prompt).toContain("Routine progress since your last turn, 30 updates in all.");
    expect(asked[0]?.prompt).toContain("- Task cook sent 30 updates. The latest: Stirred 30 times");
    expect(asked[0]?.prompt).not.toContain("Stirred 29 times");

    // The one turn consumed every update along with the Failure.
    const settled = await run(settledItems(progress.map((item) => item.id)));
    expect(settled.every((item) => item.disposition?._tag === "consumed")).toBe(true);
    await run(Effect.sleep("150 millis"));
    expect(continued().filter((request) => !request.prompt.includes(IDLE_QUEST))).toHaveLength(1);
  }, 10_000);

  it("progress that piled up rides along your next message as one digest, and that turn consumes it", async () => {
    const { run, requests } = setUp(FrodoAndSam);
    await run(samsTask);
    const progress = await run(reportProgress(3));

    const sent = await run(ChatService.use((chat) => chat.sendPrompt(channelId, "How is Sam doing?")));
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

  it("a turn that carried only progress and ended early holds nothing back, and the progress never runs out of deliveries", async () => {
    const { run, requests, release } = setUp(FrodoAndSam);
    const cook = await run(samsTask);
    const progress = await run(reportProgress(2));

    /** The progress once it is back to pending, delivered `count` times. */
    const pendingAfter = (count: number) =>
      retry(
        Effect.flatMap(itemsOf(progress.map((item) => item.id)), (items) =>
          items.every((item) => item.state === "pending" && item.deliveries.length === count)
            ? Effect.succeed(items)
            : Effect.fail("not yet" as const),
        ),
      );

    // Three of your messages are cut off, each carrying the progress: it goes back to pending every
    // time. Each waits for the last to send it back, so every one of them carries it.
    for (let round = 1; round <= 3; round++) {
      await run(ChatService.use((chat) => chat.sendPrompt(channelId, `fake:cut-off try ${round}`)));
      await run(messagesWhen((each) => each.length === round * 2));
      await run(pendingAfter(round));
    }
    const after = await run(pendingAfter(3));
    expect(after.every((item) => item.error === null)).toBe(true);

    // You stop the next one: that holds back nothing, so work that needs Frodo still starts at once.
    holdPrompt = "Stew?";
    await run(ChatService.use((chat) => chat.sendPrompt(channelId, "Stew?")));
    // Its runtime has the prompt, so the turn is registered and the stop reaches it.
    await run(
      retry(
        Effect.flatMap(messages(), (all) =>
          all.length === 8 && all.at(-1)?.status === "streaming" && requests.some((r) => r.prompt === "Stew?")
            ? Effect.void
            : Effect.fail("not yet" as const),
        ),
      ),
    );
    // A stop sent in the instant the turn starts can miss it (seen on PostgreSQL), so it is sent again until it lands.
    await run(
      retry(
        ChatService.use((chat) => chat.stop(channelId)).pipe(
          Effect.andThen(messages()),
          Effect.flatMap((all) => (all.at(-1)?.status === "stopped" ? Effect.void : Effect.fail("not yet" as const))),
        ),
      ),
    );
    await release();
    await run(TaskRepository.use((tasks) => tasks.moveTask(cook.id, cook.revision, "failed", now)));
    await run(ChatService.use((chat) => chat.wake(channelId)));
    const all = await run(messagesWhen((each) => each.length === 9));
    expect(all[8]?.content).toContain("ended as failed.");
    const asked = requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain("- Task cook sent 2 updates. The latest: Stirred 2 times");
    const settled = await run(settledItems(progress.map((item) => item.id)));
    expect(settled.every((item) => item.disposition?._tag === "consumed")).toBe(true);
  }, 15_000);
});

describe("blockers", () => {
  /** Your choice for the item's blocker numbered `blocker`, through the hub's host. */
  const choose = (itemId: BackpackItem["id"], action: "retry" | "dismiss", blocker = 1) =>
    decideBlocker(itemId, blocker, action).pipe(Effect.provide(BlockersHostLive));

  it("work whose every turn is cut off becomes a blocker instead of disappearing, and Retry starts it again", async () => {
    cutContinuations = true;
    const { run } = setUp();
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    await run(ChatService.use((chat) => chat.wake(channelId)));
    const [blocked] = await run(settledItems([failure.id]));
    expect(blocked).toMatchObject({ state: "failed" });
    expect(blocked?.blockers).toMatchObject([
      {
        number: 1,
        reason: "retries-exhausted",
        nextAction: "retry",
        lastEnd: "interrupted",
        afterDeliveries: 3,
        decision: null,
      },
    ]);
    // What the runtime said is kept raw for diagnosis; the client writes the explanation.
    expect(blocked?.blockers[0]?.diagnostic).toBe(blocked?.error);
    expect(blocked?.error ?? "").not.toContain("Delivered");
    const listed = await run(Backpack.use((backpack) => backpack.listBlocked({ _tag: "Workspace" })));
    expect(listed.map((each) => each.id)).toEqual([failure.id]);

    cutContinuations = false;
    const retried = await run(choose(failure.id, "retry"));
    expect(retried.state).not.toBe("failed");
    const all = await run(messagesWhen((each) => each.at(-1)?.status === "complete"));
    expect(all.map((m) => m.status)).toEqual(["interrupted", "interrupted", "interrupted", "complete"]);
    const [settled] = await run(settledItems([failure.id]));
    expect(settled?.disposition).toEqual({ _tag: "consumed", by: all[3]?.id });
    expect(settled?.blockers).toMatchObject([{ decision: "retry" }]);
    // Choosing Retry again finds it made.
    expect((await run(choose(failure.id, "retry"))).state).toBe("resolved");
  });

  it("work whose turn was cut off waits through a pause put on it during the backoff, spending no delivery (#1446)", async () => {
    cutContinuations = true;
    const { run } = setUp(Frodo, { ...LIMITS, firstRetry: "500 millis", maxRetry: "500 millis" });
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    await run(ChatService.use((chat) => chat.wake(channelId)));
    await run(messagesWhen((all) => all.some((m) => m.status === "interrupted")));
    // You pause the Quest before the dispatcher tries again: it holds the work and claims nothing.
    const before = dispatches;
    await run(TaskControls.use((controls) => controls.pause(TaskId.make("quest"), false)));
    await run(retry(Effect.suspend(() => (dispatches > before ? Effect.void : Effect.fail("not yet" as const)))));
    const [item] = await run(itemsOf([failure.id]));
    expect(item).toMatchObject({ state: "pending", blockers: [] });
    expect(item?.deliveries).toHaveLength(1);
    expect((await run(messages())).filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("work you stopped until it ran out of deliveries becomes a blocker, and Retry starts it without a message", async () => {
    holdContinuations = true;
    const { run, requests, release } = setUp(Frodo, { ...LIMITS, maxDeliveries: 1 });
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    await run(ChatService.use((chat) => chat.wake(channelId)));
    // The continuation reached the runtime and waits there, before it writes, when you stop it.
    await run(
      retry(
        Effect.flatMap(messages(), (all) =>
          all.at(-1)?.status === "streaming" && requests.length === 1 ? Effect.void : Effect.fail("not yet" as const),
        ),
      ),
    );
    await run(ChatService.use((chat) => chat.stop(channelId)));
    await run(messagesWhen((all) => all.at(-1)?.status === "stopped"));
    await release();
    const [blocked] = await run(settledItems([failure.id]));
    expect(blocked).toMatchObject({ state: "failed" });
    // You stopped it: a code the client words, and nothing the runtime said (STD-I18N-005).
    expect(blocked?.blockers).toMatchObject([
      { reason: "retries-exhausted", nextAction: "retry", lastEnd: "stopped", diagnostic: null },
    ]);
    expect(blocked?.error).toBeNull();

    holdContinuations = false;
    await run(choose(failure.id, "retry"));
    const all = await run(messagesWhen((each) => each.at(-1)?.status === "complete"));
    expect(all.map((m) => [m.role, m.status])).toEqual([
      ["assistant", "stopped"],
      ["assistant", "complete"],
    ]);
  }, 10_000);

  it("a retired hob's waiting work becomes a blocker to dismiss, and cannot be retried", async () => {
    const { run } = setUp();
    await run(HobLifecycle.use((hobs) => hobs.pause(FRODO)));
    const failure = await run(failedStep);
    if (failure === undefined) throw new Error("no Failure recorded");
    await run(HobLifecycle.use((hobs) => hobs.retire(FRODO, "stop")));
    const [blocked] = await run(settledItems([failure.id]));
    expect(blocked).toMatchObject({ state: "failed", error: null });
    expect(blocked?.blockers).toMatchObject([
      { reason: "recipient-retired", nextAction: "dismiss", diagnostic: null, lastEnd: null },
    ]);

    const refused = await run(Effect.flip(choose(failure.id, "retry")));
    expect(refused).toMatchObject({ _tag: "BlockerRecipientRetired", agentId: FRODO });
    const dismissed = await run(choose(failure.id, "dismiss"));
    expect(dismissed).toMatchObject({ state: "resolved", disposition: { _tag: "dismissed", by: null } });
    const closed = await run(Effect.flip(choose(failure.id, "retry")));
    expect(closed).toMatchObject({ _tag: "BackpackItemNotBlocked", blocker: 1, state: "resolved" });
    expect(await run(messages())).toEqual([]);
  });
});

describe("turn limits", () => {
  it("answers every one of many chats sent at once to one hob, four turns at a time (#1448, #1590)", async () => {
    const ids = Array.from({ length: 13 }, (_, n) => ChannelId.make(`chat-${n + 1}`));
    const ManyChats: Before = Layer.effectDiscard(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* repo.insertAgent(frodo);
        for (const id of ids) {
          yield* repo.upsertChannel(new Channel({ id, ownerHobId: FRODO, title: id, createdAt: now, updatedAt: now }));
        }
      }),
    );
    const cap = 4;
    const { run, release } = setUp(ManyChats, LIMITS, cap);
    // The first four turns hold until the gate opens, so the other nine messages wait, queued.
    const sent = await Promise.all(
      ids.map((id) => run(ChatService.use((chat) => chat.sendPrompt(id, `${HOLD} Hello from ${id}`)))),
    );
    expect(sent.filter((each) => each.userMessage.status === "queued")).toHaveLength(ids.length - cap);
    await release();
    // A channel that finds no backpack work keeps its slot for your message, so every chat is
    // answered, never more than four at once.
    for (const id of ids) {
      await run(
        waitUntil(
          Effect.gen(function* () {
            const report = yield* Effect.flatMap(
              Effect.serviceOption(TurnSlots),
              (slots) => Option.getOrThrow(slots).report,
            );
            expect(report.active.length).toBeLessThanOrEqual(cap);
            return (yield* HobbotsRepository.use((repo) => repo.listMessages(id))).map((m) => m.status).join();
          }),
          (statuses) => statuses === "complete,complete",
          { what: `${id} to be answered` },
        ),
      );
    }
  });
});

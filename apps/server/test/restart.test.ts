import {
  ApprovalService,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  TaskRepository,
} from "@hobbots/agents";
import { Agent, AgentId, AttemptId, type BackpackItem, type Message, TaskId, Thread, ThreadId } from "@hobbots/domain";
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
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Schedule, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Recovery after a restart (EX-004, ADR 019): two hubs, one after the other, on the same database.
// The first stops at a chosen point without ending anything, as a crash leaves its records; the
// second starts over them, and nothing the first left behind is lost.

const now = "2026-11-02T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const threadId = ThreadId.make("shire");
/** A prompt with this line keeps its turn running until the first hub stops. */
const HOLD = "fake:hold";
/** How every continuation's prompt starts (ADR 019). */
const CONTINUATION = "Hobbots wrote this, not the user.";

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/**
 * The fake runtime, recording every prompt. A turn whose prompt holds `HOLD`, and every
 * continuation when `holdContinuations` is set, never ends: the hub stops while it runs.
 */
const runtimeOf = (requests: Array<PromptRequest>, holdContinuations: boolean) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          requests.push(request);
          const stream = fake.sendPrompt(request);
          // A held continuation writes nothing before Hobbots stops.
          if (holdContinuations && request.prompt.startsWith(CONTINUATION)) return Stream.never;
          return request.prompt.includes(HOLD) ? stream.pipe(Stream.concat(Stream.never)) : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));

const makeHub = (database: Layer.Layer<Layer.Success<typeof TestDatabase>>, runtime: ReturnType<typeof runtimeOf>) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(
      ContinuationsLive.pipe(Layer.provideMerge(Dispatcher.layer()), Layer.provideMerge(DispatcherHostLive)),
    ),
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(ApprovalService.layer),
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
        runtime,
      ),
    ),
    Layer.provideMerge(database),
  );

type Hub = ReturnType<typeof makeHub>;
type HubRuntime = ManagedRuntime.ManagedRuntime<Layer.Success<Hub>, Layer.Error<Hub>>;

const open: Array<HubRuntime> = [];
let databaseScope: Scope.Closeable | undefined;

afterEach(async () => {
  // The first hub never ended its turns, as after a crash; it goes last, with the database.
  for (const each of open.reverse()) await each.dispose();
  open.length = 0;
  if (databaseScope !== undefined) await Effect.runPromise(Scope.close(databaseScope, Exit.void));
  databaseScope = undefined;
});

/** One database that outlives the hubs started over it. */
const sharedDatabase = async () => {
  const scope = await Effect.runPromise(Scope.make());
  databaseScope = scope;
  return Layer.succeedContext(await Effect.runPromise(Layer.buildWithScope(TestDatabase, scope)));
};

/** Starts a hub over the database: what it does at start runs before this returns. */
const start = async (
  database: Layer.Layer<Layer.Success<typeof TestDatabase>>,
  options: { readonly holdContinuations?: boolean } = {},
) => {
  const requests: Array<PromptRequest> = [];
  const runtime: HubRuntime = ManagedRuntime.make(
    makeHub(database, runtimeOf(requests, options.holdContinuations ?? false)),
  );
  open.push(runtime);
  await runtime.runPromise(Effect.void);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<Hub>>) => runtime.runPromise(effect);
  return { run, requests };
};

/** Writes records as a hub that stopped right after would have left them, with nothing running. */
const leftBehind = <A, E>(
  database: Layer.Layer<Layer.Success<typeof TestDatabase>>,
  write: Effect.Effect<A, E, HobbotsRepository | TaskRepository>,
) =>
  Effect.runPromise(
    Effect.provide(
      write,
      Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive).pipe(
        Layer.provideMerge(Layer.mergeAll(BackpackLive, EventJournal.layer)),
        Layer.provideMerge(database),
      ),
    ),
  );

/** Frodo's Task and one step of it whose session has ended, in `ended`, while the step stayed open. */
const stepWhoseSessionEnded = (ended: "completed" | "failed") =>
  Effect.gen(function* () {
    yield* frodoAndThread;
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
    const attempt = {
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: now,
    } as const;
    const started = yield* tasks.startAttempt(step.value.id, step.value.revision, {
      id: AttemptId.make("walk"),
      ...attempt,
    });
    yield* tasks.updateAttempt(started.value.attempt.id, {
      state: ended,
      outcome: "The step's session finished.",
      at: now,
    });
    return step.value.id;
  });

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }));

const until = <A, E, R>(read: Effect.Effect<A, E, R>, ready: (value: A) => boolean) =>
  retry(Effect.flatMap(read, (value) => (ready(value) ? Effect.succeed(value) : Effect.fail("not yet" as const))));

const messages = HobbotsRepository.use((repo) => repo.listMessages(threadId));

/** The thread's messages once `ready` holds for them and every reply has ended. */
const messagesWhen = (ready: (all: ReadonlyArray<Message>) => boolean) =>
  until(messages, (all) => all.every((m) => m.status !== "streaming" && m.status !== "stopping") && ready(all));

const openItems = Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: FRODO }));

/** Frodo's open items of `kind` once there are `count` of them in `state`. */
const itemsWhen = (kind: BackpackItem["kind"], state: BackpackItem["state"], count = 1) =>
  until(
    Effect.map(openItems, (items) => items.filter((item) => item.kind === kind)),
    (items) => items.length === count && items.every((item) => item.state === state),
  );

const settled = (id: BackpackItem["id"]) =>
  until(
    Backpack.use((backpack) => backpack.find(id)),
    (item) => item.state === "resolved" || item.state === "failed",
  );

/** Frodo and his thread, stored by the first hub. */
const frodoAndThread = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
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
    }),
  );
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
  );
});

/** Continuations: replies with no message of yours before them. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

describe("recovering after a restart", () => {
  // covers EX-004, IN-004
  it("[TC-OR-110] a step's result recorded just before Hobbots stopped reaches its lead once it starts again", async () => {
    const database = await sharedDatabase();
    const first = await start(database);
    await first.run(frodoAndThread);
    // Frodo's turn plans one step and is still running when the step finishes: its result waits.
    const prompt = ["Carry the ring", HOLD, hub("plan_steps", { key: "plan", steps: [{ brief: "Walk" }] })];
    await first.run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt.join("\n"))));
    const [result] = await first.run(itemsWhen("result", "pending"));
    if (result === undefined) throw new Error("no result recorded");

    // Hobbots stops before Frodo hears of it. The next start ends the turn it cut off, and the
    // result starts a continuation without anyone writing.
    const second = await start(database);
    const all = await second.run(messagesWhen((each) => each.length === 3));
    expect(all.map((m) => m.status)).toEqual(["complete", "complete", "complete"]);
    expect(continuations(all)).toHaveLength(1);
    expect(second.requests.find((r) => r.prompt.startsWith(CONTINUATION))?.prompt).toContain("finished. Its result:");
    const done = await second.run(settled(result.id));
    expect(done.disposition).toEqual({ _tag: "consumed", by: all[2]?.id });
  });

  // covers EX-004, IN-004
  it("[TC-OR-111] a continuation cut off by a restart runs again under a new claim, and its earlier claim is refused", async () => {
    const database = await sharedDatabase();
    const first = await start(database, { holdContinuations: true });
    await first.run(frodoAndThread);
    const prompt = ["Carry the ring", hub("plan_steps", { key: "plan", steps: [{ brief: "Walk" }] })].join("\n");
    await first.run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    // The result starts a continuation, which holds the item's claim when Hobbots stops.
    const [claimed] = await first.run(
      until(
        Effect.map(openItems, (items) => items.filter((item) => item.kind === "result")),
        (items) =>
          items.length === 1 &&
          items[0]?.claim !== null &&
          first.requests.some((r) => r.prompt.startsWith(CONTINUATION)),
      ),
    );
    const held = claimed?.claim;
    if (claimed === undefined || held === null || held === undefined) throw new Error("no claim held");

    const second = await start(database);
    // At start the earlier claim is expired with a new fencing token: its owner can apply nothing.
    const renewed = await second.run(
      Backpack.use((backpack) => backpack.renew(claimed.id, { owner: held.owner, token: held.token }, "1 minute")).pipe(
        Effect.flip,
      ),
    );
    expect(renewed._tag).toBe("StaleBackpackClaim");

    // The continuation runs again in the second hub and consumes the item there.
    const all = await second.run(messagesWhen((each) => each.length === 4));
    expect(all.map((m) => m.status)).toEqual(["complete", "complete", "interrupted", "complete"]);
    const done = await second.run(settled(claimed.id));
    expect(done.disposition).toEqual({ _tag: "consumed", by: all[3]?.id });
    expect(done.fencingToken).toBeGreaterThan(held.token);
    expect(second.requests.filter((r) => r.prompt.startsWith(CONTINUATION))).toHaveLength(1);
  });

  // covers EX-004, IN-004
  it("[TC-OR-112] a step cut off by a restart fails, and its lead hears of it without anyone writing", async () => {
    const database = await sharedDatabase();
    const first = await start(database);
    await first.run(frodoAndThread);
    // The step's own session never ends: Hobbots stops while it runs.
    const prompt = ["Carry the ring", hub("plan_steps", { key: "plan", steps: [{ brief: `Walk\n${HOLD}` }] })];
    await first.run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt.join("\n"))));
    await first.run(
      until(
        TaskRepository.use((tasks) => tasks.listLiveAttempts),
        (live) => live.length === 1,
      ),
    );
    await first.run(messagesWhen((each) => each.length === 2));

    // The next start ends the step as failed, since what it did is not known, and its Failure
    // continues Frodo's thread.
    const second = await start(database);
    const all = await second.run(messagesWhen((each) => each.length === 3));
    expect(continuations(all)).toHaveLength(1);
    expect(all[2]?.content).toContain("ended as failed.");
    const [tree] = await second.run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)));
    expect(tree?.tasks.find((task) => task.brief.startsWith("Walk"))?.state).toBe("failed");
    expect(await second.run(TaskRepository.use((tasks) => tasks.listLiveAttempts))).toEqual([]);
  });

  // covers EX-004, IN-004
  it("[TC-OR-113] a step whose session ended just before Hobbots stopped fails at the next start, and its lead hears of it", async () => {
    const database = await sharedDatabase();
    const stepId = await leftBehind(database, stepWhoseSessionEnded("failed"));

    // Nothing ends the step on its own: the next start fails it, and its Failure continues the thread.
    const second = await start(database);
    const all = await second.run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.content).toContain("ended as failed.");
    const [tree] = await second.run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)));
    expect(tree?.tasks.find((task) => task.id === stepId)?.state).toBe("failed");
    expect(await second.run(TaskRepository.use((tasks) => tasks.listStrandedSteps))).toEqual([]);
  });

  // covers EX-004
  it("[TC-OR-114] a step being cancelled when Hobbots stopped is cancelled at the next start, and so is the Task above it", async () => {
    const database = await sharedDatabase();
    const stepId = await leftBehind(
      database,
      Effect.gen(function* () {
        const stepId = yield* stepWhoseSessionEnded("completed");
        const tasks = yield* TaskRepository;
        // You cancelled the Task; its step had not confirmed the cancel yet.
        for (const id of [TaskId.make("quest"), stepId]) {
          const [tree] = yield* tasks.readThreadTrees(threadId);
          const found = tree?.tasks.find((each) => each.id === id);
          if (found === undefined) throw new Error(`no Task ${id}`);
          yield* tasks.moveTask(id, found.revision, "cancelling", now);
        }
        return stepId;
      }),
    );

    const second = await start(database);
    const [tree] = await second.run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)));
    expect(tree?.tasks.find((task) => task.id === stepId)?.state).toBe("cancelled");
    expect(tree?.tasks.find((task) => task.id === TaskId.make("quest"))?.state).toBe("cancelled");
  });
});

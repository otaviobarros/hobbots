import {
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
import { Agent, AgentId, TaskId, Thread, ThreadId } from "@hobbots/domain";
import { Backpack, DEFAULT_DISPATCH_LIMITS, Dispatcher, DispatcherHost, type DispatchLimits } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import {
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// ThreadRun through the chat (ADR 037, #1371). Random scripts of sends, Send now, stops, work that
// arrives for the hob, stops racing arrivals, turns that finish and restarts run against one thread
// with the real dispatcher. Every turn waits until the script finishes or stops it, so after each step
// the chat must have started exactly the turns a small model of the run predicts, carrying work or
// not, with the queue the model predicts.

const at = "2026-01-01T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const THREAD_ID = ThreadId.make("shire");
const CONTINUATION = "Hobbots wrote this, not the user.";
const RIDES_ALONG = "Hobbots adds this, not the user.";

/** A turn the runtime was asked for, as the script sees it. */
interface Start {
  readonly kind: "user" | "continuation";
  /** The message the turn answers; null for a continuation. */
  readonly text: string | null;
  /** Whether backpack work went into the turn, as its prompt or riding along. */
  readonly carries: boolean;
}

/** The runtime's turns in the order asked, each held until the script lets it finish. */
interface Runtime {
  readonly starts: Array<Start>;
  readonly gates: Array<Deferred.Deferred<void>>;
  /** How many turns the runtime is running now: asked for, not yet finished, stopped or cut off. */
  live: number;
  /** How many deliveries of backpack work the dispatcher has under way, each until its turn ended. */
  delivering: number;
}

/** The hub's continuations, counting the deliveries under way. */
const counted = (runtime: Runtime) =>
  Layer.effect(
    Continuations,
    Effect.gen(function* () {
      const live = yield* Continuations;
      return Continuations.of({
        ...live,
        deliver: (threadId, agentId, turn) =>
          Effect.suspend(() => {
            runtime.delivering += 1;
            return live.deliver(threadId, agentId, turn);
          }).pipe(Effect.ensuring(Effect.sync(() => (runtime.delivering -= 1)))),
      });
    }),
  ).pipe(Layer.provide(ContinuationsLive));

const gated = (runtime: Runtime) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request: PromptRequest) => {
          const continuation = request.prompt.startsWith(CONTINUATION);
          runtime.starts.push({
            kind: continuation ? "continuation" : "user",
            text: continuation ? null : request.prompt,
            carries: continuation || (request.briefing?.includes(RIDES_ALONG) ?? false),
          });
          const gate = Deferred.makeUnsafe<void>();
          runtime.gates.push(gate);
          runtime.live += 1;
          return Stream.unwrap(Effect.as(Deferred.await(gate), fake.sendPrompt(request))).pipe(
            Stream.ensuring(Effect.sync(() => (runtime.live -= 1))),
          );
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

// No backoff and no running out of deliveries, so a stopped item waits only on the run.
const LIMITS: DispatchLimits = {
  ...DEFAULT_DISPATCH_LIMITS,
  maxDeliveries: 1000,
  firstRetry: "0 millis",
  maxRetry: "0 millis",
};

/** The database, built once so it outlives each life of the hub. */
type Database = Layer.Layer<Layer.Success<typeof TestDatabase>>;

/** One life of the hub over `database`: the chat, the dispatcher and the arrival wake. */
const hubLayer = (database: Database, runtime: Runtime) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(
      counted(runtime).pipe(Layer.provideMerge(Dispatcher.layer(LIMITS)), Layer.provideMerge(DispatcherHostLive)),
    ),
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        BackpackLive,
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) })),
        HobAdmission.layer,
        gated(runtime),
      ),
    ),
    Layer.provideMerge(database),
  );

type Hub = ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof hubLayer>>, never>;

/** A database that outlives each life of the hub, with Frodo and his thread. */
const openDatabase = async (scope: Scope.Closeable): Promise<Database> => {
  const database = Layer.succeedContext(await Effect.runPromise(Layer.buildWithScope(TestDatabase, scope)));
  const seed = Effect.gen(function* () {
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
        createdAt: at,
      }),
    );
    yield* repo.upsertThread(
      new Thread({ id: THREAD_ID, agentId: FRODO, title: "The quest", createdAt: at, updatedAt: at }),
    );
  });
  await Effect.runPromise(Effect.provide(seed, HobbotsRepositoryLive.pipe(Layer.provideMerge(database))));
  return database;
};

/** A step of a Task of Frodo's in the thread fails: its Failure is work that needs him. */
const arrive = (n: number) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const task = (id: string, parentId: string | null) => ({
      id: TaskId.make(id),
      ownerId: FRODO,
      parentId: parentId === null ? null : TaskId.make(parentId),
      threadId: THREAD_ID,
      brief: `Brief for ${id}`,
      dependsOn: [],
      createdAt: at,
    });
    yield* tasks.createTask({ task: task(`quest-${n}`, null), delegation: null, milestones: [] });
    const step = yield* tasks.createTask({ task: task(`step-${n}`, `quest-${n}`), delegation: null, milestones: [] });
    const failed = yield* tasks.moveTask(step.value.id, step.value.revision, "failed", at);
    // Published as the hub publishes what a Task tool commits, so the arrival wakes the thread.
    yield* DispatcherHost.use((host) => host.announce(failed.entries));
  });

type Op =
  | { readonly _tag: "Send" }
  | { readonly _tag: "SendNow" }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Arrive" }
  // A stop and an arrival at once: either may land first.
  | { readonly _tag: "StopAndArrive" }
  | { readonly _tag: "Finish" }
  | { readonly _tag: "Restart" };

const ops: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ _tag: "Send" } as const) },
  { weight: 2, arbitrary: fc.constant({ _tag: "SendNow" } as const) },
  { weight: 2, arbitrary: fc.constant({ _tag: "Stop" } as const) },
  { weight: 2, arbitrary: fc.constant({ _tag: "Arrive" } as const) },
  { weight: 1, arbitrary: fc.constant({ _tag: "StopAndArrive" } as const) },
  { weight: 4, arbitrary: fc.constant({ _tag: "Finish" } as const) },
  { weight: 1, arbitrary: fc.constant({ _tag: "Restart" } as const) },
);

/** The run as ADR 019 and 037 describe it, written apart from the chat. */
interface Model {
  readonly running: Start | null;
  /** Items the running turn carries; they go back to waiting if it stops or the hub restarts. */
  readonly carried: number;
  /** Items that wait for a turn. */
  readonly waiting: number;
  readonly queue: ReadonlyArray<string>;
  readonly chosen: string | null;
  /** Whether you stopped a turn that carried work, so the work waits for your next message. */
  readonly held: boolean;
  readonly starts: ReadonlyArray<Start>;
  readonly sent: ReadonlyArray<string>;
}

const empty: Model = {
  running: null,
  carried: 0,
  waiting: 0,
  queue: [],
  chosen: null,
  held: false,
  starts: [],
  sent: [],
};

const begin = (m: Model, start: Start): Model => ({
  ...m,
  running: start,
  carried: start.carries ? m.waiting : 0,
  waiting: start.carries ? 0 : m.waiting,
  starts: [...m.starts, start],
});

/** What a free thread starts: your next message (the chosen first), with any waiting work along. */
const startNext = (m: Model): Model => {
  if (m.running !== null) return m;
  // A message of yours takes the work you stopped along with it.
  const free = m.held && m.queue.length > 0 ? { ...m, held: false } : m;
  if (free.held) return free;
  const next = free.chosen !== null && free.queue.includes(free.chosen) ? free.chosen : free.queue[0];
  if (next !== undefined) {
    const taken = { ...free, queue: free.queue.filter((text) => text !== next), chosen: null };
    return begin(taken, { kind: "user", text: next, carries: free.waiting > 0 });
  }
  return free.waiting > 0 ? begin(free, { kind: "continuation", text: null, carries: true }) : free;
};

/** The running turn ends; a stopped one leaves its work waiting, held if it carried any. */
const ended = (m: Model, stopped: boolean): Model => {
  if (m.running === null) return m;
  const held = m.held || (stopped && m.running.carries);
  const waiting = stopped ? m.waiting + m.carried : m.waiting;
  return startNext({ ...m, running: null, carried: 0, waiting, held });
};

const sendNow = (m: Model): Model => {
  const last = m.sent.at(-1);
  if (last === undefined || !m.queue.includes(last)) return m; // refused: it already started
  return ended({ ...m, chosen: last }, true);
};

const step = (m: Model, op: Op): Model => {
  switch (op._tag) {
    case "Send": {
      const text = `m${m.sent.length}`;
      return startNext({ ...m, sent: [...m.sent, text], queue: [...m.queue, text], held: false });
    }
    case "SendNow":
      return sendNow(m);
    case "Stop":
      return ended(m, true);
    case "Arrive":
      return startNext({ ...m, waiting: m.waiting + 1 });
    case "StopAndArrive":
      throw new Error("a race has two outcomes; use outcomes()");
    case "Finish":
      return ended(m, false);
    case "Restart":
      // The turn that ran is cut off and its work waits again; what was held or chosen is forgotten.
      return startNext({
        ...m,
        running: null,
        carried: 0,
        waiting: m.waiting + m.carried,
        held: false,
        chosen: null,
      });
  }
};

/** What the chat may do on `op` from each outcome still possible: one, or one per order a race can land in. */
const outcomes = (models: ReadonlyArray<Model>, op: Op): ReadonlyArray<Model> => {
  const all = models.flatMap((m) =>
    op._tag === "StopAndArrive"
      ? [step(step(m, { _tag: "Stop" }), { _tag: "Arrive" }), step(step(m, { _tag: "Arrive" }), { _tag: "Stop" })]
      : [step(m, op)],
  );
  return [...new Map(all.map((m) => [JSON.stringify(m), m])).values()];
};

/**
 * What the hub shows of the run: its queue, the chat's turns, replies still stopping, and the Failures still open,
 * waiting or in a turn. Read under Frodo's lock, so no step of the run is half done.
 */
const recordsNow = HobAdmission.use((admission) => admission.withHob(FRODO, records));
const records = Effect.gen(function* () {
  const messages = yield* HobbotsRepository.use((repo) => repo.listMessages(THREAD_ID));
  // The Failures that arrived; each Task's own item starts it elsewhere, not in this thread.
  const open = (yield* Backpack.use((b) => b.listOpen({ _tag: "Hob", agentId: FRODO }))).filter(
    (item) => item.kind === "failure",
  );
  return {
    queue: messages.filter((m) => m.status === "queued").map((m) => m.content),
    turns: (yield* ChatService.use((chat) => chat.activeThreads)).length,
    stopping: messages.filter((m) => m.status === "stopping").length,
    waiting: open.filter((item) => item.state === "pending").length,
    carried: open.filter((item) => item.state !== "pending").length,
  };
});

/**
 * The same, as the model says once the hub is at rest: a turn runs while the runtime runs one, only a
 * turn that carries work holds a delivery and its items, and no reply is left stopping.
 */
const shown = (m: Model) =>
  JSON.stringify({
    starts: m.starts,
    live: m.running === null ? 0 : 1,
    delivering: m.running?.carries === true ? 1 : 0,
    queue: m.queue,
    turns: m.running === null ? 0 : 1,
    stopping: 0,
    waiting: m.waiting,
    carried: m.carried,
  });

/**
 * Waits, up to a time limit, until the runtime, the queue and the backpack show one of the model's
 * outcomes, and returns every outcome that agrees with what the hub did. Each state the hub passes
 * through on the way, such as a turn that has ended before its work is resolved, matches no outcome,
 * so the step is over only once the hub is at rest. A race whose two orders look alike so far keeps
 * both, until a later step tells them apart.
 */
const agree = async (hub: Hub, runtime: Runtime, models: ReadonlyArray<Model>, script: ReadonlyArray<Op>) => {
  const observed = async () => {
    const { queue, turns, stopping, waiting, carried } = await hub.runPromise(recordsNow);
    const { starts, live, delivering } = runtime;
    return JSON.stringify({ starts, live, delivering, queue, turns, stopping, waiting, carried });
  };
  const expected = models.map(shown);
  const deadline = Date.now() + 10_000;
  let seen = await observed();
  while (!expected.includes(seen) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    seen = await observed();
  }
  const matched = models.filter((_, index) => expected[index] === seen);
  if (matched.length === 0)
    expect.fail(`after ${JSON.stringify(script)}: saw ${seen}, expected one of ${[...new Set(expected)].join(" or ")}`);
  return matched;
};

const play = async (script: ReadonlyArray<Op>) => {
  const scope = await Effect.runPromise(Scope.make());
  const database = await openDatabase(scope);
  const runtime: Runtime = { starts: [], gates: [], live: 0, delivering: 0 };
  let hub: Hub = ManagedRuntime.make(hubLayer(database, runtime));
  let models: ReadonlyArray<Model> = [empty];
  // What every outcome agrees on: the messages sent and the turns started.
  const model = () => models[0] as Model;
  const running = () => models.some((each) => each.running !== null);
  let arrivals = 0;
  const chat = <A, E>(f: (chat: ChatService["Service"]) => Effect.Effect<A, E>) => hub.runPromise(ChatService.use(f));
  /** Does what `op` says to the hub, as you or the hub's work would. */
  const perform = async (op: Op) => {
    switch (op._tag) {
      case "Send":
        await chat((c) => c.sendPrompt(THREAD_ID, `m${model().sent.length}`));
        break;
      case "SendNow": {
        const last = model().sent.at(-1);
        if (last === undefined) break;
        const queued = (await hub.runPromise(HobbotsRepository.use((repo) => repo.listMessages(THREAD_ID)))).find(
          (m) => m.content === last,
        );
        if (queued !== undefined) await chat((c) => Effect.ignore(c.sendNow(THREAD_ID, queued.id)));
        break;
      }
      case "Stop":
        await chat((c) => c.stop(THREAD_ID));
        break;
      case "Arrive":
        await hub.runPromise(arrive(arrivals++));
        break;
      case "StopAndArrive":
        await hub.runPromise(
          Effect.all([ChatService.use((c) => c.stop(THREAD_ID)), arrive(arrivals++)], {
            concurrency: "unbounded",
            discard: true,
          }),
        );
        break;
      case "Finish": {
        // Finishing a turn that already stopped does nothing.
        const gate = running() ? runtime.gates.at(-1) : undefined;
        if (gate !== undefined) await Effect.runPromise(Deferred.succeed(gate, undefined));
        break;
      }
      case "Restart":
        await hub.dispose();
        hub = ManagedRuntime.make(hubLayer(database, runtime));
        await hub.runPromise(Effect.void);
        break;
    }
  };
  /** Does `op`, then keeps the outcomes that agree with what the chat did. */
  const apply = async (op: Op, done: ReadonlyArray<Op>) => {
    await perform(op);
    models = await agree(hub, runtime, outcomes(models, op), done);
  };
  try {
    await hub.runPromise(Effect.void);
    for (const [index, op] of script.entries()) await apply(op, script.slice(0, index + 1));
    // Finishing every turn, and writing once more for work you stopped, leaves nothing waiting.
    const finish: Op = { _tag: "Finish" };
    const finishAll = async () => {
      for (let left = 20; running() && left > 0; left--) await apply(finish, [...script, finish]);
    };
    await finishAll();
    if (models.some((each) => each.waiting > 0)) {
      await apply({ _tag: "Send" }, [...script, { _tag: "Send" }]);
      await finishAll();
    }
    expect(running()).toBe(false);
    // Every Failure that arrived was taken in by a turn.
    const failures = await hub.runPromise(
      Backpack.use((b) => b.listOpen({ _tag: "Hob", agentId: FRODO })).pipe(
        Effect.map((open) => open.filter((item) => item.kind === "failure")),
      ),
    );
    expect(failures).toEqual([]);
    return model();
  } finally {
    await hub.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

describe("a thread's run through the chat", () => {
  // covers CH-002, CH-007, CH-008, IN-004
  it("[TC-CH-293] starts the turns its model predicts, carrying work or not, whatever sends, Send now, stops, arrivals and restarts do", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ops, { minLength: 1, maxLength: 14 }), async (script) => {
        const model = await play(script);
        // Every message you sent ran once.
        const answered = model.starts.flatMap((start) => (start.text === null ? [] : [start.text]));
        expect([...answered].sort()).toEqual([...model.sent].sort());
      }),
      { numRuns: 60 },
    );
  }, 300_000);
});

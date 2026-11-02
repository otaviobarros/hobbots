import { HobbotsRepository, type NewTask, TaskRepository, TaskToolCalls } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  type BackpackItem,
  CheckpointId,
  type Committed,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import {
  Backpack,
  BackpackTurnFailed,
  Dispatcher,
  DispatcherHost,
  type DispatchLimits,
  type Turn,
} from "@hobbots/inbox";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

/** Quick retries, so a test that exhausts them stays short. */
const LIMITS: DispatchLimits = { lease: "1 minute", maxDeliveries: 3, firstRetry: "5 millis", maxRetry: "20 millis" };

const Host = Layer.effect(
  DispatcherHost,
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    return DispatcherHost.of({
      treeOf: (taskId) =>
        tasks.readTree(taskId).pipe(
          Effect.flatMap((found) => {
            const rootId = Option.getOrUndefined(found)?.tasks[0]?.rootId;
            return rootId === undefined ? Effect.succeed(Option.none()) : tasks.readTree(rootId);
          }),
          Effect.map((tree) => (Option.isSome(tree) ? tree.value.tasks : [])),
        ),
      announce: () => Effect.void,
    });
  }),
);

const Stores = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  BackpackLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));
const layer = (limits: DispatchLimits) =>
  Dispatcher.layer(limits).pipe(Layer.provide(Host), Layer.provideMerge(Stores));
const runStores = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | TaskToolCalls | Backpack | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(Stores), Effect.runPromise);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    HobbotsRepository | TaskRepository | TaskToolCalls | Backpack | Dispatcher | SqlClient.SqlClient
  >,
  limits: DispatchLimits = LIMITS,
) => effect.pipe(Effect.provide(layer(limits)), Effect.runPromise);

const now = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const threadId = ThreadId.make("t1");

const newTask = (id: string, ownerId: AgentId, parentId: string | null): NewTask => ({
  id: TaskId.make(id),
  ownerId,
  parentId: parentId === null ? null : TaskId.make(parentId),
  threadId,
  brief: `Brief for ${id}`,
  dependsOn: [],
  createdAt: now,
});

const recorded = (committed: Committed<unknown>): BackpackItem => {
  const entry = committed.entries.find((each) => each.payload._tag === "BackpackItemRecorded");
  if (entry === undefined || entry.payload._tag !== "BackpackItemRecorded") throw new Error("no item recorded");
  return entry.payload.item;
};

/** Aldric leads a Quest and delegates the copy to Quill: Quill's backpack holds the Task item. */
const campaign = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [ALDRIC, "Aldric"],
    [QUILL, "Quill"],
  ] as const) {
    yield* repo.insertAgent(
      new Agent({
        id,
        name,
        roleTitle: "Guide",
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
  }
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: ALDRIC, title: "Campaign", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  const root = yield* tasks.createTask({ task: newTask("campaign", ALDRIC, null), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: root.value.id,
    goal: "A campaign",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  const copy = yield* tasks.createTask({
    task: newTask("copy", QUILL, "campaign"),
    delegation: {
      id: DelegationId.make("d-copy"),
      brief: "Write the copy",
      expectedOutput: null,
      authority: { overrides: {}, folders: null },
      timeoutMs: null,
    },
    milestones: [],
  });
  return { root: root.value, copy: copy.value, item: recorded(copy) };
});

/**
 * Quill's turn: the runtime accepts it, and it commits one effect, a finding on its Task, through
 * the hob tools' ledger under the delivery's key, so applying it again finds the first. `runs`
 * counts how often the turn ran. `before` runs between acceptance and the effect, and `after`
 * between the effect and the turn's end. With `consumes`, the effect resolves the item with it.
 */
const reportingTurn =
  (
    services: { readonly tasks: TaskRepository["Service"]; readonly ledger: TaskToolCalls["Service"] },
    runs: { count: number },
    options: {
      readonly before?: Effect.Effect<void>;
      readonly after?: Effect.Effect<void>;
      readonly consumes?: boolean;
    } = {},
  ) =>
  (item: BackpackItem): Turn => ({
    target: `thread:${item.threadId}`,
    turnId: `turn-${runs.count + 1}`,
    run: (delivery) =>
      Effect.gen(function* () {
        runs.count++;
        yield* delivery.accepted(`session-${runs.count}`);
        yield* options.before ?? Effect.void;
        const { tasks, ledger } = services;
        const report = ledger
          .once(
            { agentId: QUILL, key: delivery.key, tool: "report_checkpoint", input: '{"kind":"finding"}', at: now },
            tasks
              .recordCheckpoint({
                id: CheckpointId.make(`c-${delivery.item.id}-${runs.count}`),
                taskId: TaskId.make("copy"),
                source: "unplanned",
                kind: "finding",
                milestoneId: null,
                summary: "The copy runs long",
                createdAt: now,
              })
              .pipe(
                Effect.map((committed) => ({ done: { message: "Reported", details: {} }, entries: committed.entries })),
              ),
          )
          .pipe(Effect.orDie);
        yield* delivery.commit(report, { consumes: options.consumes ?? false });
        yield* options.after ?? Effect.void;
      }),
  });

const count = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly count: unknown }>`SELECT COUNT(*) AS count FROM ${sql(table)}`;
    return Number(row?.count);
  });

describe("The dispatcher", () => {
  // covers IN-003
  it("[TC-IN-027] delivers an item once however often it is dispatched, and a redelivered item applies its effect once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { item } = yield* campaign;
        const dispatcher = yield* Dispatcher;
        const backpack = yield* Backpack;
        const services = { tasks: yield* TaskRepository, ledger: yield* TaskToolCalls };
        const runs = { count: 0 };

        // Dispatched twice at once and once more after: one turn runs and the item is consumed.
        const together = yield* Effect.all(
          [
            dispatcher.dispatch(item.id, reportingTurn(services, runs, { consumes: true })),
            dispatcher.dispatch(item.id, reportingTurn(services, runs, { consumes: true })),
          ],
          { concurrency: "unbounded" },
        );
        const again = yield* dispatcher.dispatch(item.id, reportingTurn(services, runs));
        const consumed = yield* backpack.find(item.id);

        // Ada's item: its first turn applies the effect, then loses its claim before it resolves,
        // as when the hub stalls past the lease. The item is delivered again, and the effect found.
        const other = recorded(
          yield* services.tasks.createTask({
            task: newTask("build", QUILL, "campaign"),
            delegation: {
              id: DelegationId.make("d-build"),
              brief: "Build the page",
              expectedOutput: null,
              authority: { overrides: {}, folders: null },
              timeoutMs: null,
            },
            milestones: [],
          }),
        );
        const applied = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const redelivered = { count: 0 };
        const first = yield* Effect.forkChild(
          dispatcher.dispatch(
            other.id,
            reportingTurn(services, redelivered, {
              after: Deferred.succeed(applied, undefined).pipe(Effect.andThen(Deferred.await(release))),
            }),
          ),
        );
        yield* Deferred.await(applied);
        yield* backpack.expireClaims({ all: true });
        yield* Deferred.succeed(release, undefined);
        const dropped = yield* Fiber.join(first);
        const second = yield* dispatcher.dispatch(other.id, reportingTurn(services, redelivered));
        return {
          together: together.map((each) => each._tag).sort(),
          again,
          runs: runs.count,
          consumed,
          dropped,
          second,
          redelivered: redelivered.count,
          checkpoints: yield* count("checkpoints"),
        };
      }),
    );

    expect(result.together).toEqual(["Consumed", "Skipped"]);
    expect(result.again).toEqual({ _tag: "Skipped", reason: "settled" });
    expect(result.runs).toBe(1);
    expect(result.consumed).toMatchObject({
      state: "resolved",
      claim: null,
      disposition: { _tag: "consumed", by: "turn-1" },
      deliveries: [{ number: 1, target: "thread:t1", turnId: "turn-1", acknowledgedSessionId: "session-1" }],
    });
    expect(result.dropped).toEqual({ _tag: "Dropped" });
    expect(result.redelivered).toBe(2);
    expect(result.second).toMatchObject({
      _tag: "Consumed",
      item: {
        deliveries: [
          { number: 1, turnId: "turn-1" },
          { number: 2, turnId: "turn-2" },
        ],
      },
    });
    // Three turns applied the effect, and it exists twice: once for each item, never twice for one.
    expect(result.checkpoints).toBe(2);
  });

  // covers IN-002, IN-003
  it("[TC-IN-031] commits nothing of an effect whose claim expired just before it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { item } = yield* campaign;
        const dispatcher = yield* Dispatcher;
        const backpack = yield* Backpack;
        const services = { tasks: yield* TaskRepository, ledger: yield* TaskToolCalls };
        const accepted = yield* Deferred.make<void>();
        const expired = yield* Deferred.make<void>();
        const before = yield* count("checkpoints");
        // The turn is accepted, and its claim expires before it commits its effect.
        const first = yield* Effect.forkChild(
          dispatcher.dispatch(
            item.id,
            reportingTurn(
              services,
              { count: 0 },
              {
                before: Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Deferred.await(expired))),
              },
            ),
          ),
        );
        yield* Deferred.await(accepted);
        yield* backpack.expireClaims({ all: true });
        yield* Deferred.succeed(expired, undefined);
        const dropped = yield* Fiber.join(first);
        return { dropped, written: (yield* count("checkpoints")) - before, stored: yield* backpack.find(item.id) };
      }),
    );

    expect(result.dropped).toEqual({ _tag: "Dropped" });
    expect(result.written).toBe(0);
    expect(result.stored).toMatchObject({ state: "pending", claim: null, disposition: null, fencingToken: 2 });
  });

  // covers IN-002, IN-003
  it("[TC-IN-030] expires at start every claim an earlier process held, so its worker is refused", async () => {
    const result = await runStores(
      Effect.gen(function* () {
        const { item } = yield* campaign;
        const backpack = yield* Backpack;
        const claimed = yield* backpack.claim(item.id, "earlier-hub:turn-1", "1 minute");
        const held = { owner: "earlier-hub:turn-1", token: claimed.value.fencingToken };
        yield* backpack.deliver(item.id, held, { target: "thread:t1", turnId: "turn-1" });
        // The hub starts again: its dispatcher comes up over the same database.
        const afterBoot = yield* Effect.gen(function* () {
          yield* Dispatcher;
          return yield* backpack.find(item.id);
        }).pipe(Effect.provide(Dispatcher.layer(LIMITS).pipe(Layer.provide(Host))));
        const stale = yield* backpack.acknowledge(item.id, held, "session-1").pipe(Effect.flip);
        return { afterBoot, stale };
      }),
    );

    expect(result.afterBoot).toMatchObject({ state: "pending", claim: null, fencingToken: 2 });
    expect(result.stale).toMatchObject({ _tag: "StaleBackpackClaim" });
  });

  // covers IN-003, IN-007
  it("[TC-IN-028] records each delivery apart from its acknowledgement, retries a turn that ended early, and fails the item once retries run out", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { item } = yield* campaign;
        const dispatcher = yield* Dispatcher;
        const backpack = yield* Backpack;
        // The transport fails once, before the runtime accepted anything; the next turn works.
        let tries = 0;
        const flaky = (each: BackpackItem): Turn => ({
          target: `thread:${each.threadId}`,
          turnId: `turn-${tries + 1}`,
          run: (delivery) =>
            ++tries === 1
              ? Effect.fail(new BackpackTurnFailed({ reason: "The runtime could not start." }))
              : delivery.accepted("session-2"),
        });
        const recovered = yield* dispatcher.dispatch(item.id, flaky);

        // Another item whose every turn ends before the runtime accepts it.
        const tasks = yield* TaskRepository;
        const other = recorded(
          yield* tasks.createTask({
            task: newTask("launch", QUILL, "campaign"),
            delegation: {
              id: DelegationId.make("d-launch"),
              brief: "Plan the launch",
              expectedOutput: null,
              authority: { overrides: {}, folders: null },
              timeoutMs: null,
            },
            milestones: [],
          }),
        );
        let silent = 0;
        const failed = yield* dispatcher.dispatch(other.id, (each) => ({
          target: `thread:${each.threadId}`,
          turnId: `silent-${++silent}`,
          run: () => Effect.void,
        }));
        return { recovered, failed, silent, stored: yield* backpack.find(other.id) };
      }),
    );

    expect(result.recovered).toMatchObject({ _tag: "Consumed" });
    if (result.recovered._tag !== "Consumed") throw new Error("not consumed");
    expect(result.recovered.item.disposition).toEqual({ _tag: "consumed", by: "turn-2" });
    // The first delivery was made and never acknowledged; only the second was.
    expect(result.recovered.item.deliveries).toMatchObject([
      { number: 1, turnId: "turn-1", acknowledgedSessionId: null, acknowledgedAt: null },
      { number: 2, turnId: "turn-2", acknowledgedSessionId: "session-2" },
    ]);
    expect(result.failed._tag).toBe("Failed");
    expect(result.silent).toBe(3);
    expect(result.stored).toMatchObject({ state: "failed", claim: null });
    expect(result.stored.deliveries.map((each) => each.acknowledgedSessionId)).toEqual([null, null, null]);
    expect(result.stored.error).toContain("The runtime never accepted the turn.");
  });

  // covers IN-002, IN-003
  it("[TC-IN-029] stops a turn whose claim expired and drops its outcome, so only the next delivery applies the item", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { item } = yield* campaign;
        const dispatcher = yield* Dispatcher;
        const backpack = yield* Backpack;
        const started = yield* Deferred.make<void>();
        let applied = 0;
        // The first turn is accepted, then waits; meanwhile its claim is expired, as a restart does.
        const slow: Turn = {
          target: "thread:t1",
          turnId: "slow",
          run: (delivery) =>
            delivery
              .accepted("session-slow")
              .pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.sleep("200 millis")),
                Effect.andThen(Effect.sync(() => applied++)),
              ),
        };
        const first = yield* Effect.forkChild(dispatcher.dispatch(item.id, () => slow));
        yield* Deferred.await(started);
        yield* backpack.expireClaims({ all: true });
        const dropped = yield* Fiber.join(first);
        const between = yield* backpack.find(item.id);
        const next = yield* dispatcher.dispatch(item.id, () => ({
          target: "thread:t1",
          turnId: "next",
          run: (delivery) => delivery.accepted("session-next").pipe(Effect.andThen(Effect.sync(() => applied++))),
        }));
        return { dropped, between, next, applied };
      }),
      { ...LIMITS, lease: "90 millis" },
    );

    expect(result.dropped).toEqual({ _tag: "Dropped" });
    expect(result.between).toMatchObject({ state: "pending", claim: null, fencingToken: 2 });
    expect(result.next).toMatchObject({ _tag: "Consumed", item: { disposition: { _tag: "consumed", by: "next" } } });
    // The stopped turn never applied its effect; the next one did, once.
    expect(result.applied).toBe(1);
  });

  // covers IN-003, OR-006
  it("[TC-OR-040] resolves a result for a cancelled Task as late and starts nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { root, copy } = yield* campaign;
        const tasks = yield* TaskRepository;
        const dispatcher = yield* Dispatcher;
        const started = yield* tasks.startAttempt(copy.id, copy.revision, {
          id: AttemptId.make("a1"),
          runtime: "claude-code",
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: now,
        });
        // Quill's result is recorded from the turn its Task item started, and Aldric's whole request
        // is cancelled before Aldric gets to it.
        const ledger = Option.getOrThrow(yield* tasks.readLedger(copy.id));
        const done = yield* tasks.completeTask(copy.id, started.value.task.revision, {
          summary: "Copy drafted",
          attemptId: AttemptId.make("a1"),
          artifacts: [],
          at: now,
          carried: carriedFrom(ledger, () => true),
        });
        const cancelled = yield* tasks.moveTask(root.id, root.revision, "cancelled", now);
        let runs = 0;
        const late = yield* dispatcher.dispatch(recorded(done).id, (each) => ({
          target: `thread:${each.threadId}`,
          turnId: "never",
          run: () => Effect.sync(() => runs++),
        }));
        return { cancelled: cancelled.value, late, runs, tree: yield* tasks.readTree(root.id) };
      }),
    );

    expect(result.late).toMatchObject({
      _tag: "Late",
      item: {
        kind: "result",
        state: "resolved",
        deliveries: [],
        disposition: { _tag: "late", taskRevision: result.cancelled.revision },
      },
    });
    expect(result.runs).toBe(0);
    // The result stays on its Task and Attempt, and the cancelled request stays cancelled.
    const tree = Option.getOrThrow(result.tree);
    expect(tree.tasks.map((each) => [each.id, each.state])).toEqual([
      ["campaign", "cancelled"],
      ["copy", "completed"],
    ]);
    expect(tree.attempts.map((each) => each.id)).toEqual(["a1"]);
  });
});

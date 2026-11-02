import {
  ancestorsOf,
  type BackpackItem,
  type BackpackItemId,
  BackpackItemMissing,
  type Committed,
  type EventEnvelope,
  IllegalBackpackTransition,
  isTerminalTask,
  type StaleBackpackClaim,
  type Task,
  type TaskId,
} from "@hobbots/domain";
import { Cause, Context, DateTime, Duration, Effect, Exit, Layer, Schedule, Schema } from "effect";
import { Backpack, type HeldClaim } from "./backpack.ts";

/**
 * How the dispatcher delivers (ADR 019): the lease a claim takes, how many times an item is put into
 * a turn before it fails, and the backoff between those times.
 */
export interface DispatchLimits {
  readonly lease: Duration.Input;
  readonly maxDeliveries: number;
  readonly firstRetry: Duration.Input;
  readonly maxRetry: Duration.Input;
}

export const DEFAULT_DISPATCH_LIMITS: DispatchLimits = {
  lease: "60 seconds",
  maxDeliveries: 3,
  firstRetry: "1 second",
  maxRetry: "30 seconds",
};

/** A turn that ended before it handled its items: a transport failure, an interruption or a runtime failure. */
export class BackpackTurnFailed extends Schema.TaggedError<BackpackTurnFailed>()("BackpackTurnFailed", {
  reason: Schema.String,
}) {}

/** What a turn is handed with the item it carries. */
export interface Delivery {
  /** The item as its claim left it. */
  readonly item: BackpackItem;
  /**
   * The idempotency key every effect of the item carries, the same on every delivery of it, so an
   * effect applied on an earlier delivery is found instead of applied again.
   */
  readonly key: string;
  /** 1 for the first delivery, one more for each retry. */
  readonly number: number;
  /** The claim the item is held under for this turn: what the turn names when its work consumes the item. */
  readonly held: HeldClaim;
  /**
   * Records the adapter's evidence that the runtime accepted the turn: its session. Only this moves
   * the item on to processing; a turn that ends without it handled nothing.
   */
  readonly accepted: (sessionId: string) => Effect.Effect<void, StaleBackpackClaim>;
  /**
   * Commits one of the item's effects, once the runtime accepted the turn, in a transaction that
   * checks the claim still holds: a turn whose claim was lost writes nothing, and fails as stale.
   * With `consumes`, the item resolves as consumed in the same transaction as its last effect.
   */
  readonly commit: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: { readonly consumes?: boolean },
  ) => Effect.Effect<A, E | StaleBackpackClaim>;
}

/** One turn that carries an item: where it runs, its id, and running it until it ends. */
export interface Turn {
  /** The thread or Attempt session the turn runs in. */
  readonly target: string;
  /** The turn's message or Attempt id. */
  readonly turnId: string;
  /**
   * Succeeds once the turn handled the item; fails with `BackpackTurnFailed` when it ended early. A
   * turn that dies or is interrupted ended early too: the item goes back to pending all the same.
   */
  readonly run: (delivery: Delivery) => Effect.Effect<void, BackpackTurnFailed | StaleBackpackClaim>;
}

/**
 * One turn that carries every item put into it (ADR 019): thirty items make one continuation, not
 * thirty. It ends as a `Turn` does, and its end settles each of its items the same way.
 */
export interface BatchTurn {
  readonly target: string;
  readonly turnId: string;
  readonly run: (deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void, BackpackTurnFailed | StaleBackpackClaim>;
}

/** How one dispatch of an item ended. */
export type Dispatched =
  /** A turn handled it, and it resolved as consumed. */
  | { readonly _tag: "Consumed"; readonly item: BackpackItem }
  /** Its Task had ended or moved on: it resolved as late and started nothing. */
  | { readonly _tag: "Late"; readonly item: BackpackItem }
  /** Every delivery ended early: it failed with the last reason. */
  | { readonly _tag: "Failed"; readonly item: BackpackItem }
  /**
   * Nothing ran: the item was settled or held by another claim before this dispatch, it is a
   * deadline whose not-before time has not come, or no turn could start for it now (`not-ready`),
   * as when its hob is paused. A `not-ready` item stays pending for a later dispatch.
   */
  | { readonly _tag: "Skipped"; readonly reason: "settled" | "claimed" | "missing" | "not-yet" | "not-ready" }
  /** This dispatch's claim was lost to expiry: its outcome was dropped, and the item waits for a new claim. */
  | { readonly _tag: "Dropped" };

/**
 * The Task an item's recipient holds it under (ADR 019): the nearest Task, from the item's own up,
 * that the recipient owns. What a member reports about its own Task, its result, failure,
 * checkpoints, progress and questions, is for the Task above it, so the search starts there.
 * Undefined when the recipient owns no Task on the way up, as after a reassignment.
 */
export const heldUnder = (item: BackpackItem, tree: ReadonlyArray<Task>): Task | undefined => {
  const task = tree.find((each) => each.id === item.taskId);
  if (task === undefined) return undefined;
  const above = ancestorsOf(task, tree);
  return (REPORTS_UP.includes(item.kind) ? above : [task, ...above]).find((each) => each.ownerId === item.recipientId);
};

/** The kinds a member reports about its own Task to the Task above it. */
const REPORTS_UP: ReadonlyArray<BackpackItem["kind"]> = ["result", "failure", "checkpoint", "progress", "question"];

/**
 * The Task an item is checked against, and whether it is late (ADR 019): the Task its recipient
 * holds it under. With none the Task was reassigned; once it has ended the recipient has nothing
 * left to do. Either way the item is late, at that Task's version.
 */
export const lateness = (item: BackpackItem, tree: ReadonlyArray<Task>): { readonly taskRevision: number } | null => {
  if (item.taskId === null) return null;
  const task = tree.find((each) => each.id === item.taskId);
  if (task === undefined) return { taskRevision: 0 };
  const held = heldUnder(item, tree);
  if (held === undefined) return { taskRevision: task.revision };
  return isTerminalTask(held.state) ? { taskRevision: held.revision } : null;
};

/** What the dispatcher needs from the hub around it. */
export class DispatcherHost extends Context.Service<
  DispatcherHost,
  {
    /** The whole Task tree the Task belongs to, or nothing when there is no such Task. */
    readonly treeOf: (taskId: TaskId) => Effect.Effect<ReadonlyArray<Task>>;
    /** Announces what a backpack write committed, after it committed. */
    readonly announce: (entries: ReadonlyArray<EventEnvelope>) => Effect.Effect<void>;
  }
>()("@hobbots/inbox/DispatcherHost") {}

/** An item this dispatch claimed, and the claim it holds it under. */
interface Claimed {
  readonly item: BackpackItem;
  readonly held: HeldClaim;
}

/**
 * Delivers backpack items at least once and has them processed once (ADR 019, IN-003). An item is
 * claimed before anything runs, so a settled or claimed item is never delivered again; every step
 * after that is guarded by its claim, so a worker whose lease ran out is refused.
 */
export class Dispatcher extends Context.Service<
  Dispatcher,
  {
    /**
     * Puts the item into a turn and moves it on as the turn goes: delivered, acknowledged by the
     * runtime's evidence, processing, then consumed. A turn that ends early sends the item back to
     * pending and it is tried again with backoff, up to the delivery limit, after which it fails.
     */
    readonly dispatch: (itemId: BackpackItemId, turn: (item: BackpackItem) => Turn) => Effect.Effect<Dispatched>;
    /**
     * Puts every one of the items still waiting into one turn, as `dispatch` does for one. `plan`
     * sees the items found waiting before any is claimed, and returns the turn, or null when no turn
     * should start now: then nothing is claimed and each item is skipped as `not-ready`. A turn
     * that ends early is planned again, with backoff, for the items it sent back to pending. Each
     * item's outcome, in the order given.
     */
    readonly dispatchAll: (
      itemIds: ReadonlyArray<BackpackItemId>,
      plan: (items: ReadonlyArray<BackpackItem>) => Effect.Effect<BatchTurn | null>,
    ) => Effect.Effect<ReadonlyArray<Dispatched>>;
    /** Ends claims whose lease ran out, so their items wait for a new claim. */
    readonly expireLapsed: Effect.Effect<void>;
  }
>()("@hobbots/inbox/Dispatcher") {
  /**
   * The dispatcher of this hub process. At start it expires every claim an earlier process held,
   * since the turns that held them are gone, and then expires lapsed claims once per lease.
   */
  static readonly layer = (limits: DispatchLimits = DEFAULT_DISPATCH_LIMITS) =>
    Layer.effect(
      Dispatcher,
      Effect.gen(function* () {
        const backpack = yield* Backpack;
        const host = yield* DispatcherHost;
        const hub = crypto.randomUUID();
        const lease = Duration.fromInputUnsafe(limits.lease);

        const announce = <A>(committed: Committed<A>) =>
          host.announce(committed.entries).pipe(Effect.as(committed.value));
        const expire = (all: boolean) => backpack.expireClaims({ all }).pipe(Effect.flatMap(announce), Effect.asVoid);

        /** Takes one step under the claim and announces it; a lost claim is refused as stale. */
        const step = <E>(write: Effect.Effect<Committed<BackpackItem>, E>) => write.pipe(Effect.flatMap(announce));

        const fail = (held: HeldClaim, item: BackpackItem, error: string) =>
          step(backpack.fail(item.id, held, error)).pipe(
            Effect.map((failed): Dispatched => ({ _tag: "Failed", item: failed })),
          );

        /** Whether the item was settled as consumed under this claim, as `complete_task` settles what it carries. */
        const settledUnder = (current: BackpackItem, held: HeldClaim) =>
          current.state === "resolved" &&
          current.fencingToken === held.token &&
          current.disposition?._tag === "consumed";

        /**
         * Keeps the claim's lease running while the turn runs; fails once the claim no longer holds,
         * unless the turn itself settled the item under it, which leaves nothing to renew.
         */
        const renewing = ({ item, held }: Claimed) =>
          backpack.renew(item.id, held, lease).pipe(
            Effect.delay(Duration.divideUnsafe(lease, 3)),
            Effect.forever,
            Effect.catchTag("StaleBackpackClaim", (stale) =>
              backpack
                .find(item.id)
                .pipe(Effect.flatMap((current) => (settledUnder(current, held) ? Effect.never : Effect.fail(stale)))),
            ),
          );

        /** Claims a waiting item for the turn, unless it is gone, settled or claimed meanwhile. */
        const claimOne = (itemId: BackpackItemId, owner: string) =>
          backpack.claim(itemId, owner, lease).pipe(
            Effect.flatMap(announce),
            Effect.map((item): Claimed | Dispatched => ({ item, held: { owner, token: item.fencingToken } })),
            Effect.catchTags({
              BackpackItemMissing: () => Effect.succeed<Dispatched>({ _tag: "Skipped", reason: "missing" }),
              BackpackItemUnclaimable: ({ reason }) =>
                Effect.succeed<Dispatched>({ _tag: "Skipped", reason: reason === "claimed" ? "claimed" : "settled" }),
            }),
          );

        /**
         * Checks a claimed item before it goes into the turn: late against its Task, or failed once
         * it was delivered as often as the limit allows. Null when it goes in.
         */
        const check = ({ item, held }: Claimed, last: { reason: string | null }) =>
          Effect.gen(function* () {
            const late = item.taskId === null ? null : lateness(item, yield* host.treeOf(item.taskId));
            if (late !== null) {
              const resolved = yield* step(backpack.resolve(item.id, held, { _tag: "late", ...late }));
              return { _tag: "Late", item: resolved } as Dispatched;
            }
            if (outOfDeliveries(item)) {
              const why = last.reason === null ? "" : ` The last: ${last.reason}`;
              return yield* fail(
                held,
                item,
                `Delivered ${item.deliveries.length} times, and every turn ended early.${why}`,
              );
            }
            return null;
          });

        /**
         * Whether the item was delivered as often as the limit allows. Routine progress never runs
         * out: it only rides along turns, so a turn that ended early leaves it for the next (IN-005).
         */
        const outOfDeliveries = (item: BackpackItem) =>
          item.actionable && item.deliveries.length >= limits.maxDeliveries;

        /** The turn ended early for this item: it fails on its last delivery, or goes back to pending (null). */
        const endedEarly = ({ item, held }: Claimed, reason: string) =>
          Effect.gen(function* () {
            if (outOfDeliveries(item)) {
              return yield* fail(
                held,
                item,
                `Delivered ${item.deliveries.length} times, and every turn ended early. The last: ${reason}`,
              );
            }
            yield* step(backpack.requeue(item.id, held));
            return null;
          });

        /**
         * After a turn that ran to its end: the item is consumed, unless the runtime never accepted
         * the turn, when it ended early (null once it is back to pending). A turn that settled the
         * item itself under this claim, as `complete_task` does when it consumes it, is taken as is;
         * otherwise it resolves as consumed by the turn, and a claim lost meanwhile is refused as
         * stale, so the outcome is dropped.
         */
        const afterTurn = (claimed: Claimed, turnId: string) =>
          Effect.gen(function* () {
            const { item, held } = claimed;
            const current = yield* backpack.find(item.id).pipe(Effect.orDie);
            if (settledUnder(current, held)) return { _tag: "Consumed", item: current } as Dispatched;
            if (current.state === "delivered" && current.claim?.token === held.token) {
              return yield* endedEarly({ item: current, held }, "The runtime never accepted the turn.");
            }
            const resolved = yield* step(backpack.resolve(item.id, held, { _tag: "consumed", by: turnId }));
            return { _tag: "Consumed", item: resolved } as Dispatched;
          });

        /** What a turn is handed with one item it carries. */
        const deliveryOf = ({ item, held }: Claimed, turnId: string): Delivery => ({
          item,
          key: `backpack:${item.id}`,
          number: item.deliveries.length,
          held,
          accepted: (sessionId) =>
            step(backpack.acknowledge(item.id, held, sessionId)).pipe(
              Effect.andThen(step(backpack.process(item.id, held))),
              Effect.asVoid,
              // This dispatch holds the item, so only a second acceptance of one turn lands here: a bug.
              Effect.catchTags({ BackpackItemMissing: Effect.die, IllegalBackpackTransition: Effect.die }),
            ),
          // The turn stops as soon as its claim is lost: another delivery may already be on its way.
          commit: (effect, options = {}) =>
            backpack.fenced(item.id, held, effect, options.consumes === true ? { consumes: turnId } : {}).pipe(
              Effect.tap(({ settled }) => (settled === null ? Effect.void : announce(settled))),
              Effect.map(({ value }) => value),
              // An effect committed before the turn was accepted is a bug in the turn.
              Effect.catchIf(
                (error) => error instanceof BackpackItemMissing || error instanceof IllegalBackpackTransition,
                Effect.die,
              ),
            ),
        });

        /** The items that have no outcome yet and wait for a turn now; the rest get theirs. */
        const findWaiting = (itemIds: ReadonlyArray<BackpackItemId>, outcomes: Map<BackpackItemId, Dispatched>) =>
          Effect.gen(function* () {
            const now = DateTime.formatIso(yield* DateTime.now);
            const waiting: Array<BackpackItem> = [];
            for (const itemId of itemIds.filter((id) => !outcomes.has(id))) {
              const found = yield* backpack.find(itemId).pipe(Effect.option);
              if (found._tag === "None") outcomes.set(itemId, { _tag: "Skipped", reason: "missing" });
              else if (found.value.notBefore !== null && found.value.notBefore > now) {
                outcomes.set(itemId, { _tag: "Skipped", reason: "not-yet" });
              } else waiting.push(found.value);
            }
            return waiting;
          });

        /** Claims each waiting item for the turn and checks it; returns those that go into the turn. */
        const claimAll = (
          waiting: ReadonlyArray<BackpackItem>,
          owner: string,
          outcomes: Map<BackpackItemId, Dispatched>,
          last: { reason: string | null },
        ) =>
          Effect.gen(function* () {
            const live: Array<Claimed> = [];
            for (const item of waiting) {
              const claimed = yield* claimOne(item.id, owner);
              if ("_tag" in claimed) {
                outcomes.set(item.id, claimed);
                continue;
              }
              const settled = yield* check(claimed, last);
              if (settled === null) live.push(claimed);
              else outcomes.set(item.id, settled);
            }
            return live;
          });

        /**
         * Runs the turn with every delivered item while their leases are renewed. A turn that dies or
         * is interrupted sends its items back to pending before the cause goes on. Returns why it
         * ended early, or null when it ran to its end.
         */
        const runTurn = (turn: BatchTurn, delivered: ReadonlyArray<Claimed>) =>
          Effect.raceFirst(
            turn.run(delivered.map((each) => deliveryOf(each, turn.turnId))),
            Effect.forEach(delivered, renewing, { concurrency: "unbounded", discard: true }),
          ).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && !Cause.hasFails(exit.cause)
                ? Effect.forEach(
                    delivered,
                    ({ item, held }) => backpack.requeue(item.id, held).pipe(Effect.flatMap(announce), Effect.ignore),
                    { discard: true },
                  )
                : Effect.void,
            ),
            Effect.as(null),
            Effect.catchTag("BackpackTurnFailed", (failed) => Effect.succeed(failed.reason)),
          );

        /**
         * One delivery of the items that have no outcome yet: found, planned, claimed, checked, put
         * into one turn, and settled by how the turn ended. Fails with `BackpackTurnFailed` when the
         * turn ended early and sent some items back to pending, so they are tried again. `last` keeps
         * why the previous delivery of this dispatch ended early.
         */
        const once = (
          itemIds: ReadonlyArray<BackpackItemId>,
          plan: (items: ReadonlyArray<BackpackItem>) => Effect.Effect<BatchTurn | null>,
          outcomes: Map<BackpackItemId, Dispatched>,
          last: { reason: string | null },
        ) =>
          Effect.gen(function* () {
            const waiting = yield* findWaiting(itemIds, outcomes);
            if (waiting.length === 0) return;
            const turn = yield* plan(waiting);
            if (turn === null) {
              for (const item of waiting) outcomes.set(item.id, { _tag: "Skipped", reason: "not-ready" });
              return;
            }
            // The claim's owner is this hub process and the turn (ADR 019).
            const live = yield* claimAll(waiting, `${hub}:${turn.turnId}`, outcomes, last);
            if (live.length === 0) return;
            const delivered = yield* Effect.forEach(live, ({ item, held }) =>
              step(backpack.deliver(item.id, held, { target: turn.target, turnId: turn.turnId })).pipe(
                Effect.map((next): Claimed => ({ item: next, held })),
              ),
            );
            const reason = yield* runTurn(turn, delivered);
            let requeued = false;
            const progressBack: Array<BackpackItemId> = [];
            for (const each of delivered) {
              const settled = reason === null ? yield* afterTurn(each, turn.turnId) : yield* endedEarly(each, reason);
              if (settled !== null) outcomes.set(each.item.id, settled);
              else if (each.item.actionable) requeued = true;
              else progressBack.push(each.item.id);
            }
            // Routine progress sent back rides along the retry that work needing the hob plans, but
            // never plans one itself: alone, it waits for the next turn.
            if (!requeued) {
              for (const id of progressBack) outcomes.set(id, { _tag: "Skipped", reason: "not-ready" });
            }
            if (requeued) {
              const why = reason ?? "The runtime never accepted the turn.";
              last.reason = why;
              return yield* new BackpackTurnFailed({ reason: why });
            }
          });

        const backoff = Schedule.max([
          Schedule.min([Schedule.exponential(limits.firstRetry), Schedule.spaced(limits.maxRetry)]),
          Schedule.recurs(Math.max(0, limits.maxDeliveries)),
        ]);

        const dispatchAll: Dispatcher["Service"]["dispatchAll"] = (itemIds, plan) =>
          Effect.suspend(() => {
            const outcomes = new Map<BackpackItemId, Dispatched>();
            const last = { reason: null as string | null };
            return once(itemIds, plan, outcomes, last).pipe(
              Effect.retry({ schedule: backoff, while: (error) => error._tag === "BackpackTurnFailed" }),
              Effect.catchTags({
                // The last delivery fails its items instead, so retries never run out first.
                BackpackTurnFailed: (error) => Effect.die(error),
                StaleBackpackClaim: () =>
                  Effect.logWarning("Dropped a backpack outcome whose claim had expired", itemIds.join(", ")),
                IllegalBackpackTransition: (error) => Effect.die(error),
                BackpackItemMissing: (error) => Effect.die(error),
              }),
              Effect.map(() => itemIds.map((id): Dispatched => outcomes.get(id) ?? { _tag: "Dropped" })),
            );
          });

        const dispatch: Dispatcher["Service"]["dispatch"] = (itemId, turn) =>
          dispatchAll([itemId], ([item]) => {
            if (item === undefined) return Effect.succeed(null);
            const planned = turn(item);
            return Effect.succeed({
              target: planned.target,
              turnId: planned.turnId,
              run: ([delivery]) => (delivery === undefined ? Effect.void : planned.run(delivery)),
            });
          }).pipe(Effect.map(([outcome]) => outcome ?? { _tag: "Dropped" }));

        // The turns that held claims before this process started are gone. One hub serves a
        // database (ADR 011), so every claim found at start is an earlier process's.
        yield* expire(true);
        // A sweep that fails is logged and the next one runs, so lapsed claims are always freed.
        const sweep = expire(false).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Could not expire lapsed backpack claims", cause)),
        );
        yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(lease))));

        return Dispatcher.of({ dispatch, dispatchAll, expireLapsed: expire(false) });
      }),
    );
}

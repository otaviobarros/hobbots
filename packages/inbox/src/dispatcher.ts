import {
  ancestorsOf,
  type BackpackItem,
  type BackpackItemId,
  BackpackItemMissing,
  BackpackTurnEnd,
  type BackpackTurnEnding,
  type Committed,
  deliveriesSinceRetry,
  descendantsOf,
  type EventEnvelope,
  IllegalBackpackTransition,
  isTerminalTask,
  pausedHolder,
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
  /** Deliveries per item before it fails as a blocker; a retry of the blocker gives it as many again. */
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

/**
 * A turn that ended before it handled its items: a transport failure, an interruption or a runtime
 * failure. `end` says how, as a code; `diagnostic` is what the runtime said, raw, or null.
 */
export class BackpackTurnFailed extends Schema.TaggedError<BackpackTurnFailed>()("BackpackTurnFailed", {
  end: BackpackTurnEnd,
  diagnostic: Schema.NullOr(Schema.String),
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
   * Whether the item is late now, read again each time: its Task ended, or its cancel was asked for,
   * after the item was claimed and checked (#993). A turn reads it once more before it starts.
   */
  readonly late: Effect.Effect<boolean>;
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

/**
 * Hands items to a turn that is already running (ADR 019, Live turn first; #1345): gives the runtime
 * the items, and returns the session of the turn they reached once it took them, or null when it did
 * not, as when the turn ended first.
 */
export type GiveToLive = (items: ReadonlyArray<BackpackItem>) => Effect.Effect<string | null>;

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
 * checkpoints, progress and questions, is for the Task above it, so the search starts there. The
 * Task you asked for has none above it: the hub's finding on it is for its own hob (#1081).
 * Undefined when the recipient owns no Task on the way up, as after a reassignment.
 */
export const heldUnder = (item: BackpackItem, tree: ReadonlyArray<Task>): Task | undefined => {
  const task = tree.find((each) => each.id === item.taskId);
  if (task === undefined) return undefined;
  const above = ancestorsOf(task, tree);
  const from = REPORTS_UP.includes(item.kind) && task.parentId !== null ? above : [task, ...above];
  return from.find((each) => each.ownerId === item.recipientId);
};

/**
 * Whether the item waits on a pause you put on the work (#1446): the Task its recipient holds it
 * under, or one above that, is paused, so no turn starts to carry it until you resume.
 */
export const heldByPause = (item: BackpackItem, tree: ReadonlyArray<Task>): boolean => {
  const held = heldUnder(item, tree);
  return held !== undefined && pausedHolder(held, tree) !== undefined;
};

/** The kinds a member reports about its own Task to the Task above it. */
const REPORTS_UP: ReadonlyArray<BackpackItem["kind"]> = ["result", "failure", "checkpoint", "progress", "question"];

/**
 * The Task an item is checked against, and whether it is late (ADR 019): the Task its recipient
 * holds it under. With none the Task was reassigned; once it has ended, or its cancel was asked
 * for, the recipient has nothing left to do (OR-006). Either way the item is late, at that Task's
 * version, and never restarts work.
 */
export const lateness = (item: BackpackItem, tree: ReadonlyArray<Task>): { readonly taskRevision: number } | null => {
  if (item.taskId === null) return null;
  const task = tree.find((each) => each.id === item.taskId);
  if (task === undefined) return { taskRevision: 0 };
  const held = heldUnder(item, tree);
  if (held === undefined) return { taskRevision: task.revision };
  return isTerminalTask(held.state) || held.state === "cancelling" ? { taskRevision: held.revision } : null;
};

/**
 * The work to resolve as late once `task` is over for good, cancelled or its tree's top ended
 * (ADR 019): the items about it or a Task under it that are late by now. Work its recipient holds
 * under a member's failed Task that can still be retried stays, since the retry takes it up again,
 * and so does everything about the rest of the tree, siblings included.
 */
export const lateWorkOf = (
  task: Task,
  tree: ReadonlyArray<Task>,
  items: ReadonlyArray<BackpackItem>,
): ReadonlyArray<BackpackItem> => {
  const subtree = new Set([task, ...descendantsOf(task, tree)].map((each) => each.id));
  return items.filter((item) => {
    if (item.taskId === null || !subtree.has(item.taskId) || lateness(item, tree) === null) return false;
    const held = heldUnder(item, tree);
    return held === undefined || !retryable(held, tree);
  });
};

/** A member's failed Task that can still be retried: nothing above it has ended or is being cancelled. */
const retryable = (task: Task, tree: ReadonlyArray<Task>) =>
  task.state === "failed" &&
  task.parentId !== null &&
  ancestorsOf(task, tree).every((above) => !isTerminalTask(above.state) && above.state !== "cancelling");

/** A turn that ran to its end without the runtime ever accepting it: nothing was said. */
const NOT_ACCEPTED: BackpackTurnEnding = { end: "not-accepted", diagnostic: null };

/** What the dispatcher needs from the hub around it. */
export class DispatcherHost extends Context.Service<
  DispatcherHost,
  {
    /** The whole Task tree the Task belongs to, or nothing when there is no such Task. */
    readonly treeOf: (taskId: TaskId) => Effect.Effect<ReadonlyArray<Task>>;
    /** Announces what a backpack write committed, after it committed. */
    readonly announce: (entries: ReadonlyArray<EventEnvelope>) => Effect.Effect<void>;
    /**
     * Whether the hub holds work after a restore (ADR 026): then nothing is claimed or delivered,
     * and every item is skipped as not ready until work resumes. Absent, work is never held.
     */
    readonly held?: Effect.Effect<boolean>;
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
    /**
     * Resolves as late each of the items that waits with no claim while its Task has ended or its
     * cancel was asked for, and starts no turn: what waits for a turn, and routine progress that
     * none will carry, once its Task is over. The others are skipped. Each item's outcome, in the
     * order given.
     */
    readonly settleLate: (itemIds: ReadonlyArray<BackpackItemId>) => Effect.Effect<ReadonlyArray<Dispatched>>;
    /** Ends claims whose lease ran out, so their items wait for a new claim. */
    readonly expireLapsed: Effect.Effect<void>;
    /**
     * Hands the items still waiting to the turn `turnId` that runs in `target` now, instead of
     * waiting for its end (ADR 019, Live turn first; #1345): each is claimed for that turn, checked
     * as a dispatch checks it, recorded as delivered into it, and given to the runtime with `give`
     * while its lease is renewed. Taken, each reached the turn and is consumed by it; not taken, or
     * the hand-off interrupted, each goes back to pending for the next turn. Returns whether any
     * was given: none is when they were taken or settled meanwhile, or are late.
     */
    readonly handToLive: (
      itemIds: ReadonlyArray<BackpackItemId>,
      turn: { readonly target: string; readonly turnId: string },
      give: GiveToLive,
    ) => Effect.Effect<boolean>;
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

        const fail = (held: HeldClaim, item: BackpackItem, ending: BackpackTurnEnding | null) =>
          step(backpack.fail(item.id, held, ending)).pipe(
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

        /** How late the item is against its Task as the Task stands now, or null when it is not. */
        const lateNow = (item: BackpackItem) =>
          item.taskId === null
            ? Effect.succeed(null)
            : Effect.map(host.treeOf(item.taskId), (tree) => lateness(item, tree));

        /**
         * Resolves a claimed item as late when its Task has ended or its cancel was asked for, so it
         * starts nothing (OR-006). Null when it is not late.
         */
        const resolveIfLate = ({ item, held }: Claimed) =>
          Effect.gen(function* () {
            const late = yield* lateNow(item);
            if (late === null) return null;
            const resolved = yield* step(backpack.resolve(item.id, held, { _tag: "late", ...late }));
            return { _tag: "Late", item: resolved } as Dispatched;
          });

        /**
         * Settles a claimed item that has nowhere to go: late against its Task, or failed once it was
         * delivered as often as the limit allows, with `ending` as the reason. Null when it goes on.
         */
        const settleSpent = (claimed: Claimed, ending: BackpackTurnEnding | null) =>
          Effect.gen(function* () {
            const late = yield* resolveIfLate(claimed);
            if (late !== null) return late;
            return outOfDeliveries(claimed.item) ? yield* fail(claimed.held, claimed.item, ending) : null;
          });

        /** Checks a claimed item before it goes into the turn, as `settleSpent` does. Null when it goes in. */
        const check = (claimed: Claimed, last: { ending: BackpackTurnEnding | null }) =>
          settleSpent(claimed, last.ending);

        /**
         * Whether the item was delivered as often as the limit allows since it was last retried.
         * Routine progress never runs out: it only rides along turns, so a turn that ended early
         * leaves it for the next (IN-005).
         */
        const outOfDeliveries = (item: BackpackItem) =>
          item.actionable && deliveriesSinceRetry(item) >= limits.maxDeliveries;

        /**
         * The turn ended early for this item: it resolves as late once its Task has ended or its
         * cancel was asked for, fails on its last delivery, or goes back to pending (null), keeping
         * how its turn ended.
         */
        const endedEarly = (claimed: Claimed, ending: BackpackTurnEnding) =>
          Effect.gen(function* () {
            // A turn stopped because its Task was cancelled leaves nothing to deliver again.
            const settled = yield* settleSpent(claimed, ending);
            if (settled !== null) return settled;
            yield* step(backpack.requeue(claimed.item.id, claimed.held));
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
              return yield* endedEarly({ item: current, held }, NOT_ACCEPTED);
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
          late: Effect.map(lateNow(item), (late) => late !== null),
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

        /**
         * Resolves the waiting items that are late already, so they wait for no turn: a late item
         * starts nothing, and needs none to settle, even where no turn can start now, as in a
         * thread whose turn you stopped. Returns the rest.
         */
        const settleLateWaiting = (waiting: ReadonlyArray<BackpackItem>, outcomes: Map<BackpackItemId, Dispatched>) =>
          Effect.filter(waiting, (item) =>
            Effect.gen(function* () {
              if ((yield* lateNow(item)) === null) return true;
              const claimed = yield* claimOne(item.id, `${hub}:late`);
              // Its Task moved on between the two reads, as a retry does: the claim lapses, and the
              // sweep sends the item back to pending for a later dispatch.
              const settled = "_tag" in claimed ? claimed : yield* resolveIfLate(claimed);
              outcomes.set(item.id, settled ?? { _tag: "Skipped", reason: "claimed" });
              return false;
            }),
          );

        /** Claims each waiting item for the turn and checks it; returns those that go into the turn. */
        const claimAll = (
          waiting: ReadonlyArray<BackpackItem>,
          owner: string,
          outcomes: Map<BackpackItemId, Dispatched>,
          last: { ending: BackpackTurnEnding | null },
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
         * is interrupted sends its items back to pending before the cause goes on, except those
         * that are late by then. Returns why it
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
                    (claimed) =>
                      resolveIfLate(claimed).pipe(
                        Effect.flatMap((late) =>
                          late === null
                            ? backpack.requeue(claimed.item.id, claimed.held).pipe(Effect.flatMap(announce))
                            : Effect.void,
                        ),
                        Effect.ignore,
                      ),
                    { discard: true },
                  )
                : Effect.void,
            ),
            Effect.as(null),
            Effect.catchTag("BackpackTurnFailed", ({ end, diagnostic }) =>
              Effect.succeed<BackpackTurnEnding | null>({ end, diagnostic }),
            ),
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
          last: { ending: BackpackTurnEnding | null },
        ) =>
          Effect.gen(function* () {
            const found = yield* findWaiting(itemIds, outcomes);
            const waiting = yield* settleLateWaiting(found, outcomes);
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
            const ending = yield* runTurn(turn, delivered);
            let requeued = false;
            const progressBack: Array<BackpackItemId> = [];
            for (const each of delivered) {
              const settled = ending === null ? yield* afterTurn(each, turn.turnId) : yield* endedEarly(each, ending);
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
              last.ending = ending ?? NOT_ACCEPTED;
              return yield* new BackpackTurnFailed(last.ending);
            }
          });

        const backoff = Schedule.max([
          Schedule.min([Schedule.exponential(limits.firstRetry), Schedule.spaced(limits.maxRetry)]),
          Schedule.recurs(Math.max(0, limits.maxDeliveries)),
        ]);

        const held = host.held ?? Effect.succeed(false);
        const notReady = (itemIds: ReadonlyArray<BackpackItemId>) =>
          itemIds.map((): Dispatched => ({ _tag: "Skipped", reason: "not-ready" }));

        const dispatchAll: Dispatcher["Service"]["dispatchAll"] = (itemIds, plan) =>
          Effect.flatMap(held, (isHeld) => (isHeld ? Effect.succeed(notReady(itemIds)) : deliverAll(itemIds, plan)));

        const deliverAll: Dispatcher["Service"]["dispatchAll"] = (itemIds, plan) =>
          Effect.suspend(() => {
            const outcomes = new Map<BackpackItemId, Dispatched>();
            const last = { ending: null as BackpackTurnEnding | null };
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

        const settleLate: Dispatcher["Service"]["settleLate"] = (itemIds) =>
          Effect.suspend(() => {
            const outcomes = new Map<BackpackItemId, Dispatched>();
            return findWaiting(itemIds, outcomes).pipe(
              Effect.map((found) => found.filter((item) => item.claim === null)),
              Effect.flatMap((found) => settleLateWaiting(found, outcomes)),
              Effect.catchCause((cause) => Effect.logWarning("Could not settle late backpack items", cause)),
              Effect.map(() =>
                itemIds.map((id): Dispatched => outcomes.get(id) ?? { _tag: "Skipped", reason: "not-ready" }),
              ),
            );
          });

        /**
         * The runtime took the item into the turn: it reached the turn, which acknowledges it under
         * the claim and records the pick-up on its note, and is consumed by that turn at once, since
         * a turn that ends early cannot hand it back.
         */
        const reachedLive = ({ item, held }: Claimed, turnId: string, sessionId: string) =>
          step(backpack.acknowledge(item.id, held, sessionId)).pipe(
            Effect.andThen(step(backpack.process(item.id, held))),
            Effect.andThen(step(backpack.resolve(item.id, held, { _tag: "consumed", by: turnId }))),
            Effect.asVoid,
          );

        const handToLive: Dispatcher["Service"]["handToLive"] = (itemIds, turn, give) =>
          Effect.suspend(() => handOnce(itemIds, turn, give, new Map<BackpackItemId, Dispatched>()));

        /**
         * Gives the delivered items to the runtime while their leases are renewed, as a dispatched
         * turn's are, so a runtime slow to take them never lets the claims lapse and the items be
         * delivered again. Returns the session that took them, null when none did, or `lost` when a
         * claim was lost all the same: the sweep has sent its item back, so nothing is settled here.
         */
        const giving = (delivered: ReadonlyArray<Claimed>, give: GiveToLive) =>
          Effect.raceFirst(
            give(delivered.map(({ item }) => item)),
            Effect.forEach(delivered, renewing, { concurrency: "unbounded", discard: true }).pipe(Effect.as(null)),
          ).pipe(
            Effect.catchTag("StaleBackpackClaim", (stale) =>
              Effect.logWarning("A message handed to a running turn lost its claim", stale).pipe(
                Effect.as("lost" as const),
              ),
            ),
            Effect.onInterrupt(() =>
              Effect.forEach(delivered, ({ item, held: claim }) => Effect.ignore(backpack.requeue(item.id, claim)), {
                discard: true,
              }),
            ),
          );

        const handOnce = (
          itemIds: ReadonlyArray<BackpackItemId>,
          turn: { readonly target: string; readonly turnId: string },
          give: GiveToLive,
          outcomes: Map<BackpackItemId, Dispatched>,
        ) =>
          Effect.gen(function* () {
            if (yield* held) return false;
            const found = yield* findWaiting(itemIds, outcomes);
            const waiting = yield* settleLateWaiting(
              found.filter((item) => item.state === "pending" && item.claim === null),
              outcomes,
            );
            const live = yield* claimAll(waiting, `${hub}:${turn.turnId}`, outcomes, { ending: null });
            if (live.length === 0) return false;
            const delivered = yield* Effect.forEach(live, ({ item, held: claim }) =>
              step(backpack.deliver(item.id, claim, turn)).pipe(
                Effect.map((next): Claimed => ({ item: next, held: claim })),
              ),
            );
            const sessionId = yield* giving(delivered, give);
            if (sessionId === "lost") return true;
            yield* Effect.forEach(
              delivered,
              (claimed) =>
                (sessionId === null
                  ? step(backpack.requeue(claimed.item.id, claimed.held))
                  : reachedLive(claimed, turn.turnId, sessionId)
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not settle a message handed to a running turn", cause),
                  ),
                ),
              { discard: true },
            );
            return true;
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Could not hand messages to a running turn", cause).pipe(Effect.as(false)),
            ),
          );

        return Dispatcher.of({ dispatch, dispatchAll, settleLate, expireLapsed: expire(false), handToLive });
      }),
    );
}

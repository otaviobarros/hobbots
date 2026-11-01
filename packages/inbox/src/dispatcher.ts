import {
  ancestorsOf,
  type BackpackItem,
  type BackpackItemId,
  type Committed,
  type EventEnvelope,
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
  /** The item as its claim left it. Any effect it causes carries `item.id`, so applying it twice finds the first. */
  readonly item: BackpackItem;
  /** 1 for the first delivery, one more for each retry. */
  readonly number: number;
  /**
   * Records the adapter's evidence that the runtime accepted the turn: its session. Only this moves
   * the item on to processing; a turn that ends without it handled nothing.
   */
  readonly accepted: (sessionId: string) => Effect.Effect<void, StaleBackpackClaim>;
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

/** How one dispatch of an item ended. */
export type Dispatched =
  /** A turn handled it, and it resolved as consumed. */
  | { readonly _tag: "Consumed"; readonly item: BackpackItem }
  /** Its Task had ended or moved on: it resolved as late and started nothing. */
  | { readonly _tag: "Late"; readonly item: BackpackItem }
  /** Every delivery ended early: it failed with the last reason. */
  | { readonly _tag: "Failed"; readonly item: BackpackItem }
  /**
   * Nothing ran: the item was settled or held by another claim before this dispatch, or it is a
   * deadline whose not-before time has not come.
   */
  | { readonly _tag: "Skipped"; readonly reason: "settled" | "claimed" | "missing" | "not-yet" }
  /** This dispatch's claim was lost to expiry: its outcome was dropped, and the item waits for a new claim. */
  | { readonly _tag: "Dropped" };

/**
 * The Task an item is checked against, and whether it is late (ADR 019): the nearest Task, from the
 * item's own up, that its recipient owns. With none the Task was reassigned; once it has ended the
 * recipient has nothing left to do. Either way the item is late, at that Task's version.
 */
export const lateness = (item: BackpackItem, tree: ReadonlyArray<Task>): { readonly taskRevision: number } | null => {
  if (item.taskId === null) return null;
  const task = tree.find((each) => each.id === item.taskId);
  if (task === undefined) return { taskRevision: 0 };
  const held = [task, ...ancestorsOf(task, tree)].find((each) => each.ownerId === item.recipientId);
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
            Effect.map((failed) => ({ _tag: "Failed", item: failed }) as const),
          );

        /** Keeps the claim's lease running while the turn runs; fails once the claim no longer holds. */
        const renewing = (itemId: BackpackItemId, held: HeldClaim) =>
          backpack.renew(itemId, held, lease).pipe(Effect.delay(Duration.divideUnsafe(lease, 3)), Effect.forever);

        /**
         * Claims the item for the turn it is to go into, unless it is gone, settled, claimed, or a
         * deadline not yet due. The claim's owner is this hub process and that turn (ADR 019).
         */
        const claimFor = (itemId: BackpackItemId, turn: (item: BackpackItem) => Turn) =>
          Effect.gen(function* () {
            const found = yield* backpack.find(itemId).pipe(Effect.option);
            if (found._tag === "None") return { _tag: "Skipped", reason: "missing" } as const;
            const now = DateTime.formatIso(yield* DateTime.now);
            if (found.value.notBefore !== null && found.value.notBefore > now) {
              return { _tag: "Skipped", reason: "not-yet" } as const;
            }
            const planned = turn(found.value);
            const owner = `${hub}:${planned.turnId}`;
            return yield* backpack.claim(itemId, owner, lease).pipe(
              Effect.flatMap(announce),
              Effect.map(
                (item) =>
                  ({ _tag: "Claimed", item, turn: planned, held: { owner, token: item.fencingToken } }) as const,
              ),
              Effect.catchTags({
                BackpackItemMissing: () => Effect.succeed({ _tag: "Skipped", reason: "missing" } as const),
                BackpackItemUnclaimable: ({ reason }) =>
                  Effect.succeed({ _tag: "Skipped", reason: reason === "claimed" ? "claimed" : "settled" } as const),
              }),
            );
          });

        /**
         * After a turn that ran to its end: the item is consumed, unless the runtime never accepted
         * the turn (`endedEarly`). A turn that settled the item itself under this claim, as
         * `complete_task` does when it consumes it, is taken as is; otherwise `resolve` decides, and a
         * claim lost meanwhile is refused as stale, so the outcome is dropped.
         */
        const afterTurn = <E>(
          itemId: BackpackItemId,
          held: HeldClaim,
          turnId: string,
          endedEarly: (reason: string) => Effect.Effect<Dispatched, E>,
        ) =>
          Effect.gen(function* () {
            const current = yield* backpack.find(itemId).pipe(Effect.orDie);
            const settledHere =
              current.state === "resolved" &&
              current.fencingToken === held.token &&
              current.disposition?._tag === "consumed";
            if (settledHere) return { _tag: "Consumed", item: current } as const;
            if (current.state === "delivered" && current.claim?.token === held.token) {
              return yield* endedEarly("The runtime never accepted the turn.");
            }
            const resolved = yield* step(backpack.resolve(itemId, held, { _tag: "consumed", by: turnId }));
            return { _tag: "Consumed", item: resolved } as const;
          });

        /**
         * One delivery: claimed, checked, put into a turn, and settled by how the turn ended. `last`
         * keeps why the previous delivery of this dispatch ended early.
         */
        const once = (itemId: BackpackItemId, turn: (item: BackpackItem) => Turn, last: { reason: string | null }) =>
          Effect.gen(function* () {
            const claimed = yield* claimFor(itemId, turn);
            if (claimed._tag === "Skipped") return claimed;
            const { item, held } = claimed;
            const { target, turnId, run } = claimed.turn;

            const late = item.taskId === null ? null : lateness(item, yield* host.treeOf(item.taskId));
            if (late !== null) {
              const resolved = yield* step(backpack.resolve(itemId, held, { _tag: "late", ...late }));
              return { _tag: "Late", item: resolved } as const;
            }
            if (item.deliveries.length >= limits.maxDeliveries) {
              const why = last.reason === null ? "" : ` The last: ${last.reason}`;
              return yield* fail(
                held,
                item,
                `Delivered ${item.deliveries.length} times, and every turn ended early.${why}`,
              );
            }

            const delivered = yield* step(backpack.deliver(itemId, held, { target, turnId }));
            const accepted = (sessionId: string) =>
              step(backpack.acknowledge(itemId, held, sessionId)).pipe(
                Effect.andThen(step(backpack.process(itemId, held))),
                Effect.asVoid,
                // This dispatch holds the item, so only a second acceptance of one turn lands here: a bug.
                Effect.catchTags({ BackpackItemMissing: Effect.die, IllegalBackpackTransition: Effect.die }),
              );
            /** The turn ended early: the item fails on its last delivery, or goes back to pending for the next. */
            const endedEarly = (reason: string) =>
              Effect.gen(function* () {
                last.reason = reason;
                if (delivered.deliveries.length >= limits.maxDeliveries) {
                  return yield* fail(
                    held,
                    delivered,
                    `Delivered ${delivered.deliveries.length} times, and every turn ended early. The last: ${reason}`,
                  );
                }
                yield* step(backpack.requeue(itemId, held));
                return yield* new BackpackTurnFailed({ reason });
              });
            // The turn stops as soon as its claim is lost: another delivery may already be on its way.
            // A turn that dies or is interrupted sends its item back to pending before the cause goes on.
            const ended = yield* Effect.raceFirst(
              run({ item: delivered, number: delivered.deliveries.length, accepted }),
              renewing(itemId, held),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && !Cause.hasFails(exit.cause)
                  ? backpack.requeue(itemId, held).pipe(Effect.flatMap(announce), Effect.ignore)
                  : Effect.void,
              ),
              Effect.result,
            );
            if (ended._tag === "Failure") {
              if (ended.failure._tag !== "BackpackTurnFailed") return yield* ended.failure;
              return yield* endedEarly(ended.failure.reason);
            }
            return yield* afterTurn(itemId, held, turnId, endedEarly);
          });

        const backoff = Schedule.max([
          Schedule.min([Schedule.exponential(limits.firstRetry), Schedule.spaced(limits.maxRetry)]),
          Schedule.recurs(Math.max(0, limits.maxDeliveries)),
        ]);

        const dispatch: Dispatcher["Service"]["dispatch"] = (itemId, turn) =>
          Effect.suspend(() => {
            const last = { reason: null as string | null };
            return once(itemId, turn, last).pipe(
              Effect.retry({ schedule: backoff, while: (error) => error._tag === "BackpackTurnFailed" }),
            );
          }).pipe(
            Effect.catchTags({
              // The last delivery fails its item instead, so retries never run out first.
              BackpackTurnFailed: (error) => Effect.die(error),
              StaleBackpackClaim: () =>
                Effect.logWarning("Dropped a backpack outcome whose claim had expired", itemId).pipe(
                  Effect.as({ _tag: "Dropped" } as Dispatched),
                ),
              IllegalBackpackTransition: (error) => Effect.die(error),
              BackpackItemMissing: (error) => Effect.die(error),
            }),
          );

        // The turns that held claims before this process started are gone. One hub serves a
        // database (ADR 011), so every claim found at start is an earlier process's.
        yield* expire(true);
        // A sweep that fails is logged and the next one runs, so lapsed claims are always freed.
        const sweep = expire(false).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Could not expire lapsed backpack claims", cause)),
        );
        yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(lease))));

        return Dispatcher.of({ dispatch, expireLapsed: expire(false) });
      }),
    );
}

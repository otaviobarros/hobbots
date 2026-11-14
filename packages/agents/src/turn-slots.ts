import {
  admitInOrder,
  DEFAULT_TURN_LIMITS,
  type TurnHolder,
  type TurnLimits,
  type TurnSlotsReport,
  type TurnTicket,
  type TurnTicketEvent,
  TurnTicketMachine,
  turnGroup,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option, Semaphore } from "effect";

/**
 * Where the turn limits are kept (#1448), so they hold across restarts. Absent, as in tests that
 * keep nothing, the hub runs with the defaults and keeps a change only while it runs.
 */
export class TurnLimitsStore extends Context.Service<
  TurnLimitsStore,
  {
    readonly get: Effect.Effect<TurnLimits>;
    readonly set: (limits: TurnLimits) => Effect.Effect<void>;
  }
>()("@hobbots/agents/TurnLimitsStore") {}

/** A turn that asks for a slot: what it starts for, and what it counts against. */
export interface TurnRequest extends TurnHolder {
  /** What the turn starts for: `thread:<id>`, `step:<id>` or `member:<id>`; one turn at a time each. */
  readonly id: string;
}

/** A slot a turn holds. Releasing it twice frees it once. */
export interface TurnSlot {
  readonly release: Effect.Effect<void>;
}

/** A waiting turn, and how to wake what it starts for once a slot may be its. */
interface Waiter {
  readonly ticket: TurnTicket;
  readonly wake: Effect.Effect<void>;
  /** Counts each time it asked, so a wake knows whether it asked again. */
  readonly asks: number;
}

/**
 * The hub's turn slots (#1448, OR-005): how many turns run at once, per hob, per Quest and per
 * runtime. `take` never waits: a turn that gets no slot is remembered, what it starts for stays
 * queued where it is kept (a queued message, a pending backpack item, a queued step), and once a
 * slot may be its, the hub runs its `wake`, which asks again. A woken turn that does not ask again,
 * as when its work went away, loses its place. Slots go to the Quest that started a turn least
 * recently first, so one busy Quest never holds every slot while another waits. Slots and waiting
 * turns live in memory, as turns do: after a restart the work kept waiting asks again.
 */
export class TurnSlots extends Context.Service<
  TurnSlots,
  {
    /** A slot for the turn now, or null when it must wait; `wake` is run once a slot may be its. */
    readonly take: (request: TurnRequest, wake: Effect.Effect<void>) => Effect.Effect<TurnSlot | null>;
    /** The turn no longer waits, as when what it started for went away. */
    readonly withdraw: (id: string) => Effect.Effect<void>;
    readonly limits: Effect.Effect<TurnLimits>;
    /** Keeps the limits, then wakes the turns that fit under them now. */
    readonly setLimits: (limits: TurnLimits) => Effect.Effect<TurnLimits>;
    readonly report: Effect.Effect<TurnSlotsReport>;
  }
>()("@hobbots/agents/TurnSlots") {
  static readonly layer = Layer.effect(
    TurnSlots,
    Effect.gen(function* () {
      const kept = Option.getOrUndefined(yield* Effect.serviceOption(TurnLimitsStore));
      let limits = kept === undefined ? DEFAULT_TURN_LIMITS : yield* kept.get;
      const lock = yield* Semaphore.make(1);
      const scope = yield* Effect.scope;
      // The turns that hold a slot, by a key of their own, so a slot is freed once.
      const active = new Map<number, TurnTicket>();
      const waiting = new Map<string, Waiter>();
      // When each Quest, or each turn outside one, last started a turn, counted by `asked`.
      const served = new Map<string, number>();
      // The waiting turns being woken now, which another wake leaves alone.
      const waking = new Set<string>();
      let counter = 0;

      const move = (ticket: TurnTicket, event: TurnTicketEvent): TurnTicket => {
        const next = TurnTicketMachine.transition(ticket, event);
        // The service sends only events the ticket's state allows: a refusal is a bug here.
        if ("_tag" in next) throw next;
        return next;
      };

      /** Who would start now, and why each other waits, in fair order; under the lock. */
      const plan = (extra?: TurnTicket) =>
        admitInOrder(
          limits,
          Array.from(active.values()),
          [...Array.from(waiting.values(), (each) => each.ticket), ...(extra === undefined ? [] : [extra])],
          served,
        );

      const release = (key: number) =>
        Effect.suspend(() => {
          const ticket = active.get(key);
          if (ticket === undefined) return Effect.void;
          return Semaphore.withPermit(
            lock,
            Effect.sync(() => {
              const held = active.get(key);
              if (held === undefined) return;
              move(held, { _tag: "Release" });
              active.delete(key);
            }),
          ).pipe(Effect.andThen(pump));
        });

      // One pump at a time: it wakes, one by one, each waiting turn that would start now. A wake that
      // did not take its slot gives up its place, and the next is woken.
      const pumping = yield* Semaphore.make(1);
      const pumpOnce: Effect.Effect<boolean> = Effect.gen(function* () {
        const due = yield* Semaphore.withPermit(
          lock,
          Effect.sync(() => {
            const next = plan().find(({ ticket, wait }) => wait === null && !waking.has(ticket.id));
            if (next === undefined) return undefined;
            waking.add(next.ticket.id);
            return waiting.get(next.ticket.id);
          }),
        );
        if (due === undefined) return false;
        yield* due.wake.pipe(Effect.catchCause((cause) => Effect.logWarning("Could not wake a waiting turn", cause)));
        yield* Semaphore.withPermit(
          lock,
          Effect.sync(() => {
            waking.delete(due.ticket.id);
            const still = waiting.get(due.ticket.id);
            if (still !== undefined && still.asks === due.asks) {
              move(still.ticket, { _tag: "Withdraw" });
              waiting.delete(due.ticket.id);
            }
          }),
        );
        return true;
      });
      const pumpAll: Effect.Effect<void> = Effect.flatMap(pumpOnce, (more) =>
        more ? Effect.suspend(() => pumpAll) : Effect.void,
      );
      const pump: Effect.Effect<void> = Effect.asVoid(Effect.forkIn(Semaphore.withPermit(pumping, pumpAll), scope));

      const take = (request: TurnRequest, wake: Effect.Effect<void>) =>
        Semaphore.withPermit(
          lock,
          Effect.sync(() => {
            const before = waiting.get(request.id);
            // A turn that asks again is weighed as it asks now, as when its chat moved to another
            // runtime while it waited, and keeps its place in the queue.
            const ticket: TurnTicket =
              before === undefined
                ? { ...request, state: "waiting", waitingOn: null, asked: counter++ }
                : { ...before.ticket, ...request };
            if (before !== undefined) waiting.set(request.id, { ...before, ticket });
            const mine = plan(before === undefined ? ticket : undefined).find((each) => each.ticket.id === request.id);
            const wait = mine?.wait ?? null;
            if (wait !== null) {
              waiting.set(request.id, {
                ticket: move(ticket, { _tag: "Wait", reason: wait }),
                wake,
                asks: counter++,
              });
              return { slot: null, others: plan().some((each) => each.wait === null && !waking.has(each.ticket.id)) };
            }
            waiting.delete(request.id);
            const key = counter++;
            active.set(key, move(ticket, { _tag: "Admit" }));
            served.set(turnGroup(ticket), key);
            return { slot: { release: release(key) } satisfies TurnSlot, others: false };
          }),
        ).pipe(
          Effect.tap(({ others }) => (others ? pump : Effect.void)),
          Effect.map(({ slot }) => slot),
        );

      const withdraw = (id: string) =>
        Semaphore.withPermit(
          lock,
          Effect.sync(() => {
            const before = waiting.get(id);
            if (before === undefined) return false;
            move(before.ticket, { _tag: "Withdraw" });
            waiting.delete(id);
            return true;
          }),
        ).pipe(
          Effect.tap((withdrew) => (withdrew ? pump : Effect.void)),
          Effect.asVoid,
        );

      const report = Semaphore.withPermit(
        lock,
        Effect.sync(
          (): TurnSlotsReport => ({
            limits,
            active: Array.from(active.values(), ({ id, agentId, runtime, quest }) => ({ id, agentId, runtime, quest })),
            waiting: plan().map(({ ticket, wait }) => ({
              id: ticket.id,
              agentId: ticket.agentId,
              runtime: ticket.runtime,
              quest: ticket.quest,
              // A turn that would start now is being woken, and keeps the reason it last waited for.
              waitingOn: wait ?? ticket.waitingOn ?? "fair-order",
            })),
            usage: "after-turn",
          }),
        ),
      );

      const setLimits = (next: TurnLimits) =>
        Effect.gen(function* () {
          if (kept !== undefined) yield* kept.set(next);
          yield* Semaphore.withPermit(
            lock,
            Effect.sync(() => {
              limits = next;
            }),
          );
          yield* pump;
          return next;
        });

      return TurnSlots.of({
        take,
        withdraw,
        limits: Effect.sync(() => limits),
        setLimits,
        report,
      });
    }),
  );
}

/** The hub's turn slots, or none on a hub without them, as in tests of one part: then no turn waits. */
export const turnSlots: Effect.Effect<TurnSlots["Service"] | null> = Effect.map(
  Effect.serviceOption(TurnSlots),
  Option.getOrNull,
);

/** The slot of a hub that limits no turns: it holds nothing. */
export const FREE_SLOT: TurnSlot = { release: Effect.void };

/** A slot from `slots`, or a free one on a hub without them. */
export const takeSlot = (
  slots: TurnSlots["Service"] | null,
  request: TurnRequest,
  wake: Effect.Effect<void>,
): Effect.Effect<TurnSlot | null> => (slots === null ? Effect.succeed(FREE_SLOT) : slots.take(request, wake));

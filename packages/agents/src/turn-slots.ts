import { MAX_ACTIVE_TURNS, type SlotTurn, type TurnSlotsReport } from "@hobbots/domain";
import { Context, Effect, Layer, Option, Semaphore } from "effect";

/** A turn that asks for a slot: what it starts for, `thread:<id>`, `step:<id>` or `member:<id>`, and its hob. */
export type SlotRequest = SlotTurn;

/** A slot a turn holds. Releasing it twice frees it once. */
export interface TurnSlot {
  readonly release: Effect.Effect<void>;
}

/** A waiting turn, and how to wake what it starts for once a slot may be its. */
interface Waiter {
  readonly turn: SlotTurn;
  readonly wake: Effect.Effect<void>;
  /** Counts each time it asked, so a wake knows whether it asked again. */
  readonly asks: number;
}

/**
 * The hub's turn slots (#1590, OR-005): at most a cap of turns run at once across the hub. `take`
 * never waits: a turn that gets no slot is remembered, what it starts for stays queued where it is
 * kept (a queued message, a pending backpack item, a queued step), and once a slot may be its, the
 * hub runs its `wake`, which asks again. Slots go to waiting turns in the order they first asked. A
 * woken turn that does not ask again, as when its work went away, loses its place. Slots and waiting
 * turns live in memory, as turns do: after a restart the work kept waiting asks again.
 */
export class TurnSlots extends Context.Service<
  TurnSlots,
  {
    /** A slot for the turn now, or null when it must wait; `wake` is run once a slot may be its. */
    readonly take: (request: SlotRequest, wake: Effect.Effect<void>) => Effect.Effect<TurnSlot | null>;
    /** The turn no longer waits, as when what it started for went away. */
    readonly withdraw: (id: string) => Effect.Effect<void>;
    readonly report: Effect.Effect<TurnSlotsReport>;
  }
>()("@hobbots/agents/TurnSlots") {
  /** Slots under `cap`; tests pass a smaller one. */
  static readonly layerWith = (cap: number) =>
    Layer.effect(
      TurnSlots,
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1);
        const scope = yield* Effect.scope;
        // The turns that hold a slot, by a key of their own, so a slot is freed once.
        const active = new Map<number, SlotTurn>();
        // The waiting turns, in the order they first asked: a Map keeps insertion order.
        const waiting = new Map<string, Waiter>();
        // The waiting turns being woken now, which another wake leaves alone.
        const waking = new Set<string>();
        let counter = 0;

        /** The waiting turns that would start now: the first ones, as many as slots are free. */
        const due = () => Array.from(waiting.values()).slice(0, Math.max(0, cap - active.size));

        const release = (key: number) =>
          Effect.suspend(() => {
            if (!active.has(key)) return Effect.void;
            return Semaphore.withPermit(
              lock,
              Effect.sync(() => void active.delete(key)),
            ).pipe(Effect.andThen(pump));
          });

        // One pump at a time: it wakes, one by one, each waiting turn that would start now. A wake that
        // did not take its slot gives up its place, and the next is woken.
        const pumping = yield* Semaphore.make(1);
        const pumpOnce: Effect.Effect<boolean> = Effect.gen(function* () {
          const next = yield* Semaphore.withPermit(
            lock,
            Effect.sync(() => {
              const found = due().find((each) => !waking.has(each.turn.id));
              if (found !== undefined) waking.add(found.turn.id);
              return found;
            }),
          );
          if (next === undefined) return false;
          yield* next.wake.pipe(
            Effect.catchCause((cause) => Effect.logWarning("Could not wake a waiting turn", cause)),
          );
          yield* Semaphore.withPermit(
            lock,
            Effect.sync(() => {
              waking.delete(next.turn.id);
              if (waiting.get(next.turn.id)?.asks === next.asks) waiting.delete(next.turn.id);
            }),
          );
          return true;
        });
        const pumpAll: Effect.Effect<void> = Effect.flatMap(pumpOnce, (more) =>
          more ? Effect.suspend(() => pumpAll) : Effect.void,
        );
        const pump: Effect.Effect<void> = Effect.asVoid(Effect.forkIn(Semaphore.withPermit(pumping, pumpAll), scope));

        const take = (request: SlotRequest, wake: Effect.Effect<void>) =>
          Semaphore.withPermit(
            lock,
            Effect.sync(() => {
              // A turn that asks again keeps its place in the queue.
              const before = waiting.get(request.id);
              const ahead = before === undefined ? waiting.size : Array.from(waiting.keys()).indexOf(request.id);
              if (active.size + ahead >= cap) {
                waiting.set(request.id, { turn: request, wake, asks: counter++ });
                return {
                  slot: null,
                  others: due().some((each) => !waking.has(each.turn.id)),
                };
              }
              waiting.delete(request.id);
              const key = counter++;
              active.set(key, request);
              return { slot: { release: release(key) } satisfies TurnSlot, others: false };
            }),
          ).pipe(
            Effect.tap(({ others }) => (others ? pump : Effect.void)),
            Effect.map(({ slot }) => slot),
          );

        const withdraw = (id: string) =>
          Semaphore.withPermit(
            lock,
            Effect.sync(() => waiting.delete(id)),
          ).pipe(
            Effect.tap((withdrew) => (withdrew ? pump : Effect.void)),
            Effect.asVoid,
          );

        const report = Semaphore.withPermit(
          lock,
          Effect.sync(
            (): TurnSlotsReport => ({
              cap,
              active: Array.from(active.values(), ({ id, agentId }) => ({ id, agentId })),
              waiting: Array.from(waiting.values(), ({ turn: { id, agentId } }) => ({ id, agentId })),
              usage: "after-turn",
            }),
          ),
        );

        return TurnSlots.of({ take, withdraw, report });
      }),
    );

  static readonly layer = TurnSlots.layerWith(MAX_ACTIVE_TURNS);
}

/** The hub's turn slots, or none on a hub without them, as in tests of one part: then no turn waits. */
export const turnSlots: Effect.Effect<TurnSlots["Service"] | null> = Effect.map(
  Effect.serviceOption(TurnSlots),
  Option.getOrNull,
);

/** The slot of a hub that caps no turns: it holds nothing. */
export const FREE_SLOT: TurnSlot = { release: Effect.void };

/** A slot from `slots`, or a free one on a hub without them. */
export const takeSlot = (
  slots: TurnSlots["Service"] | null,
  request: SlotRequest,
  wake: Effect.Effect<void>,
): Effect.Effect<TurnSlot | null> => (slots === null ? Effect.succeed(FREE_SLOT) : slots.take(request, wake));

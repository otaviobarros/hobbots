import { EventPublisher } from "@hobbots/agents";
import type { EventEnvelope, TransientEvent } from "@hobbots/domain";
import { Context, Effect, Layer, PubSub, type Scope, Stream } from "effect";

/** What the bus carries: a committed journal entry, or a transient reply chunk or step list (ADR 013). */
export type BusEvent =
  | { readonly _tag: "Journaled"; readonly entry: EventEnvelope }
  | { readonly _tag: "Transient"; readonly event: TransientEvent };

/**
 * In-process fan-out of journal entries that are already committed, plus transient reply events.
 * A wake-up signal, not a durable queue: the event journal is the record and decides the order.
 */
export class EventBus extends Context.Service<
  EventBus,
  {
    /** Announces entries a write committed, in sequence order. */
    readonly publish: (entries: ReadonlyArray<EventEnvelope>) => Effect.Effect<void>;
    readonly publishTransient: (event: TransientEvent) => Effect.Effect<void>;
    /** Every event from now on; it ends once the bus closes. */
    readonly stream: Stream.Stream<BusEvent>;
    /** Subscribes now, so nothing published from here on is missed by a reader that starts later. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<BusEvent>, never, Scope.Scope>;
    /** Ends every stream, so a closing server has no endless response left to wait for. */
    readonly close: Effect.Effect<void>;
  }
>()("@hobbots/server/EventBus") {
  /** The bus, which also publishes for the use cases. */
  static readonly layer = Layer.effect(
    EventPublisher,
    Effect.map(EventBus, (bus) => EventPublisher.of(bus)),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        EventBus,
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<BusEvent>();
          return EventBus.of({
            publish: (entries) =>
              PubSub.publishAll(
                pubsub,
                entries.map((entry) => ({ _tag: "Journaled", entry }) as const),
              ).pipe(Effect.asVoid),
            publishTransient: (event) => PubSub.publish(pubsub, { _tag: "Transient", event }).pipe(Effect.asVoid),
            stream: Stream.fromPubSub(pubsub),
            subscribe: PubSub.subscribe(pubsub),
            close: PubSub.shutdown(pubsub),
          });
        }),
      ),
    ),
  );
}

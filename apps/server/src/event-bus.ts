import type { HobbotsEvent } from "@hobbots/domain";
import { Context, Effect, Layer, PubSub, Stream } from "effect";

/** In-process fan-out of events that were already persisted. Not a durable queue. */
export class EventBus extends Context.Service<
  EventBus,
  {
    readonly publish: (event: HobbotsEvent) => Effect.Effect<void>;
    readonly stream: Stream.Stream<HobbotsEvent>;
  }
>()("@hobbots/server/EventBus") {
  static readonly layer = Layer.effect(
    EventBus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<HobbotsEvent>();
      return EventBus.of({
        publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
        stream: Stream.fromPubSub(pubsub),
      });
    }),
  );
}

import { Deferred, Effect, Stream } from "effect";
import type { RuntimeEvent } from "./runtime.ts";

/**
 * A turn's events, which Stop waiting can end while the turn only waits on commands it started
 * (#1056). The runtime says so with `AwaitingCommands`; the wait lasts until one of those commands
 * ends, since its end starts a follow-up. Once `stop` is done the runtime's stream is ended, which
 * stops what it runs on every runtime, and each command the turn still waited on is reported
 * `ToolStopped`. `stopped` hears how many there were: none means the stop came while the hob was
 * not waiting, so the turn was stopped like any other.
 */
export const stoppableWait = <E, R>(
  events: Stream.Stream<RuntimeEvent, E, R>,
  stop: Deferred.Deferred<void>,
  stopped: (count: number) => Effect.Effect<void>,
): Stream.Stream<RuntimeEvent, E, R> =>
  Stream.suspend(() => {
    let waiting: ReadonlyArray<string> = [];
    const track = (event: RuntimeEvent) => {
      switch (event._tag) {
        case "AwaitingCommands":
          waiting = event.ids;
          return;
        // A command that ends starts a follow-up, so the turn no longer only waits.
        case "ToolFinished":
        case "ToolUncertain":
          if (waiting.includes(event.id)) waiting = [];
          return;
        case "TextDelta":
        case "StepStarted":
          waiting = [];
          return;
        default:
          return;
      }
    };
    const after = Stream.unwrap(
      Effect.gen(function* () {
        if (!(yield* Deferred.isDone(stop))) return Stream.empty;
        const ids = waiting;
        yield* stopped(ids.length);
        return Stream.fromIterable(ids.map((id): RuntimeEvent => ({ _tag: "ToolStopped", id })));
      }),
    );
    return events.pipe(
      Stream.tap((event) => Effect.sync(() => track(event))),
      Stream.interruptWhen(Deferred.await(stop)),
      Stream.concat(after),
    );
  });

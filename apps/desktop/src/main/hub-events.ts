/**
 * Follows the hub's event stream from the main process, so the menu-bar icon and the request
 * notifications learn of changes as they happen, with every window closed, and an idle app sends
 * no requests. Electron stays out of this file; index.ts passes the hub in.
 */
import { Data, Duration, Effect, Fiber, Schedule, Stream } from "effect";
import { type Event, makeParser } from "effect/encoding/Sse";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { frameChange, type HubChange } from "./hub-events-model.ts";

export interface HubEventsOptions {
  /** The hub's `/api/events` URL. */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Whether the hub may answer now; the stream is followed only while it may. */
  readonly canConnect: () => boolean;
  /**
   * The stream connected. Unless `resumed`, the hub could not replay what was missed since the last
   * connection, so anything may have changed.
   */
  readonly onConnected: (resumed: boolean) => void;
  readonly onChange: (change: HubChange) => void;
  /**
   * A connection ended or could not be made: the hub stopped, stopped answering, or dropped it.
   * Called after every failed try, so the hub's health is checked again while it stays out of reach.
   */
  readonly onLost: () => void;
  readonly fetch?: typeof globalThis.fetch;
  /** The wait before connecting again, doubling after each failed try up to `maxRetryMs`. */
  readonly firstRetryMs?: number;
  readonly maxRetryMs?: number;
  /** How long the stream may stay silent before it counts as lost. */
  readonly silenceMs?: number;
}

/** The hub sends a keep-alive every 15 seconds; three missed ones mean it stopped answering. */
const SILENCE_MS = 45_000;

/** The connection ended: closed by the hub, or silent too long. Reconnecting follows the schedule. */
class StreamEnded extends Data.TaggedError("StreamEnded") {}

/**
 * The server-sent events in a text stream. The hub's `retry` hint is dropped: when to connect again
 * is this follower's schedule.
 */
const sseEvents = <E, R>(text: Stream.Stream<string, E, R>) =>
  Stream.suspend(() => {
    let parsed: Array<Event> = [];
    const parser = makeParser((event) => {
      if (event._tag === "Event") parsed.push(event);
    });
    return text.pipe(
      Stream.mapEffect((chunk) => {
        const tooLarge = parser.feed(chunk);
        const events = parsed;
        parsed = [];
        return tooLarge ? Effect.fail(tooLarge) : Effect.succeed(events);
      }),
      Stream.flattenIterable,
    );
  });

/** Follows the stream until interrupted, connecting again after each loss on a doubling, capped schedule. */
const follow = (options: HubEventsOptions) => {
  const { url, headers = {}, onConnected, onChange, onLost } = options;
  // The cursor of the last entry received. Each connection resumes after it, so the hub replays
  // what was missed while the stream was down (ADR 013).
  let cursor: string | undefined;
  // Any bytes, keep-alives included, show the hub still answers; silence past the limit ends it.
  const bytes = HttpClientResponse.stream(
    Effect.suspend(() =>
      HttpClient.get(url, {
        headers: { accept: "text/event-stream", ...headers, ...(cursor !== undefined && { "last-event-id": cursor }) },
      }),
    ).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk)),
  ).pipe(Stream.timeout(Duration.millis(options.silenceMs ?? SILENCE_MS)));
  const retry = Schedule.min([
    Schedule.exponential(Duration.millis(options.firstRetryMs ?? 1_000)),
    Schedule.spaced(Duration.millis(options.maxRetryMs ?? 30_000)),
  ]);
  return bytes.pipe(
    Stream.decodeText,
    sseEvents,
    Stream.concat(Stream.fail(new StreamEnded())),
    Stream.tapError(() => Effect.sync(onLost)),
    // The schedule starts over once a connection delivers its first frame.
    Stream.retry(retry),
    Stream.runForEach((frame) =>
      Effect.sync(() => {
        if (frame.id !== undefined) cursor = frame.id;
        const change = frameChange(frame);
        if (change?._tag === "Connected") onConnected(change.resumed);
        else if (change !== null) onChange(change);
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch),
  );
};

/**
 * Follows the stream while the hub may answer. Answers `sync`, to call whenever that may have
 * changed, which connects at once to a hub that just started, and `stop`.
 */
export const followHub = (options: HubEventsOptions) => {
  let following: Fiber.Fiber<unknown, unknown> | null = null;
  const halt = async () => {
    const fiber = following;
    following = null;
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
  };
  const sync = () => {
    if (options.canConnect()) following ??= Effect.runFork(follow(options));
    else void halt();
  };
  sync();
  return { sync, stop: halt };
};

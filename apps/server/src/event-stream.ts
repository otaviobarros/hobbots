import { ChatService } from "@hobbots/agents";
import { EventEnvelope, STREAM_FRAME, type StreamReady, type TransientEvent } from "@hobbots/domain";
import { EventJournal, type JournalHead } from "@hobbots/persistence";
import { type Cause, Context, Effect, Exit, Fiber, Layer, PubSub, Queue, Schema, Scope, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type BusEvent, EventBus } from "./event-bus.ts";

/** What a connection sends, in order: `Ready`, journal entries by sequence, transient reply events, keep-alives (ADR 013). */
export type StreamFrame =
  | ({ readonly _tag: "Ready" } & StreamReady)
  | { readonly _tag: "Entry"; readonly cursor: string; readonly entry: EventEnvelope }
  | { readonly _tag: "Transient"; readonly event: TransientEvent }
  | KeepAlive;

type KeepAlive = { readonly _tag: "KeepAlive" };
const keepAlive: KeepAlive = { _tag: "KeepAlive" };
const KEEP_ALIVE_INTERVAL = "15 seconds";

/** Frames a connection may hold for a client that reads slower than events arrive (ADR 013). */
export const CONNECTION_BUFFER = 1_000;

/** Cursors are opaque to clients: the journal's epoch and a sequence in it. */
export const formatCursor = (epoch: string, sequence: number) => `${epoch}.${sequence}`;

export const parseCursor = (cursor: string): { readonly epoch: string; readonly sequence: number } | null => {
  const dot = cursor.lastIndexOf(".");
  const sequence = cursor.slice(dot + 1);
  if (dot <= 0 || !/^\d+$/.test(sequence)) return null;
  return { epoch: cursor.slice(0, dot), sequence: Number(sequence) };
};

/**
 * The sequence a connection resumes after, or null when the cursor cannot be resumed: it is missing,
 * malformed, from another epoch, ahead of the journal, or older than the oldest retained entry.
 */
export const resumePoint = (cursor: string | undefined, head: JournalHead, oldest: number | null): number | null => {
  const parsed = cursor === undefined ? null : parseCursor(cursor);
  if (parsed === null || parsed.epoch !== head.epoch || parsed.sequence > head.sequence) return null;
  // Every entry after the cursor must still be in the journal, or the replay would have a hole.
  if (parsed.sequence < head.sequence && (oldest === null || oldest > parsed.sequence + 1)) return null;
  return parsed.sequence;
};

const encodeEnvelope = Schema.encodeSync(EventEnvelope);

/** Writes one frame in the SSE wire format. Only journal entries and `Ready` carry an `id`. */
export const encodeFrame = (frame: StreamFrame): string => {
  switch (frame._tag) {
    case "Ready":
      return `id: ${frame.cursor}\nevent: ${STREAM_FRAME.ready}\ndata: ${JSON.stringify({ cursor: frame.cursor, resumed: frame.resumed })}\n\n`;
    case "Entry":
      return `id: ${frame.cursor}\ndata: ${JSON.stringify(encodeEnvelope(frame.entry))}\n\n`;
    case "Transient":
      return `event: ${STREAM_FRAME.delta}\ndata: ${JSON.stringify(frame.event)}\n\n`;
    case "KeepAlive":
      return ": keep-alive\n\n";
  }
};

/**
 * One client's view of the event stream: `Ready`, then every journal entry after its cursor in
 * sequence order, then the text of each reply still streaming, then live events with no gap. The
 * bus only wakes the connection; the journal decides the order and fills any gap.
 */
export class EventStream extends Context.Service<
  EventStream,
  {
    /** Frames for a connection resuming after `cursor`; a cursor that cannot resume starts fresh. */
    readonly connect: (cursor: string | undefined) => Stream.Stream<StreamFrame>;
  }
>()("@hobbots/server/EventStream") {
  static readonly layer = Layer.effect(
    EventStream,
    Effect.gen(function* () {
      const journal = yield* EventJournal;
      const bus = yield* EventBus;
      const chat = yield* ChatService;

      const connect = (cursor: string | undefined) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // The fiber writing this connection's response, ended at once when the client falls behind.
            const writer = yield* Effect.fiber;
            // Subscribed before reading the head, so an entry committed meanwhile arrives on the bus.
            // The subscription has its own scope so an overflow can release it without waiting for
            // the response to end, which a client that stopped reading would hold off indefinitely.
            const subscriptionScope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(subscriptionScope, Exit.void));
            const subscription = yield* bus.subscribe.pipe(Scope.provide(subscriptionScope));
            // A client that falls this far behind is disconnected and resumes from its cursor. The
            // keep-alives share the buffer, so nothing downstream reads ahead of the client.
            const buffer = yield* Queue.dropping<BusEvent | KeepAlive, Cause.Done>(CONNECTION_BUFFER);
            const overflow = Effect.gen(function* () {
              yield* Scope.close(subscriptionScope, Exit.void);
              yield* Queue.clear(buffer);
              // Interrupting the writer destroys the response even while it waits for the client.
              yield* Fiber.interrupt(writer).pipe(Effect.forkDetach);
            });
            yield* PubSub.take(subscription).pipe(
              Effect.flatMap((event) => Queue.offer(buffer, event)),
              Effect.repeat({ while: (offered) => offered }),
              Effect.andThen(overflow),
              // Also when the bus shuts down, so a stopping server has no endless response to wait for.
              Effect.ensuring(Queue.end(buffer)),
              Effect.forkScoped,
            );
            yield* Queue.offer(buffer, keepAlive).pipe(
              Effect.delay(KEEP_ALIVE_INTERVAL),
              Effect.forever,
              Effect.forkScoped,
            );

            const head = yield* journal.head;
            const resumeAfter = resumePoint(cursor, head, yield* journal.oldest);
            let sent = resumeAfter ?? head.sequence;

            const entry = (envelope: EventEnvelope): StreamFrame => {
              sent = envelope.sequence;
              return { _tag: "Entry", cursor: formatCursor(head.epoch, envelope.sequence), entry: envelope };
            };
            // Everything committed after the last entry sent, page by page.
            const catchUp: Stream.Stream<StreamFrame> = Stream.suspend(() =>
              Stream.unwrap(
                journal
                  .readAfter(sent)
                  .pipe(
                    Effect.map((entries) =>
                      entries.length === 0
                        ? Stream.empty
                        : Stream.fromIterable(entries).pipe(Stream.map(entry), Stream.concat(catchUp)),
                    ),
                  ),
              ),
            );
            // The full text of each reply still streaming, as a chunk at offset 0. Steps are in the journal.
            const text = Stream.fromIterableEffect(chat.streamingReplies).pipe(
              Stream.map(
                (message): StreamFrame => ({
                  _tag: "Transient",
                  event: {
                    _tag: "MessageDelta",
                    threadId: message.threadId,
                    messageId: message.id,
                    offset: 0,
                    delta: message.content,
                  },
                }),
              ),
            );
            const live = Stream.fromQueue(buffer).pipe(
              Stream.flatMap((event): Stream.Stream<StreamFrame> => {
                if (event._tag === "KeepAlive") return Stream.succeed(event);
                if (event._tag === "Transient") return Stream.succeed({ _tag: "Transient", event: event.event });
                if (event.entry.sequence <= sent) return Stream.empty;
                if (event.entry.sequence === sent + 1) return Stream.succeed(entry(event.entry));
                // Entries are missing before this one: read them from the journal, this one included.
                return catchUp;
              }),
            );

            const ready: StreamFrame = {
              _tag: "Ready",
              cursor: formatCursor(head.epoch, sent),
              resumed: resumeAfter !== null,
            };
            return Stream.succeed(ready).pipe(Stream.concat(catchUp), Stream.concat(text), Stream.concat(live));
          }),
        );

      return EventStream.of({ connect });
    }),
  );
}

/**
 * `GET /api/events`: the event stream over SSE. The browser's `EventSource` sends `Last-Event-ID`
 * when it reconnects; a first connection may pass `?after=<cursor>`, and the header wins.
 */
export const EventStreamRoute = HttpRouter.add(
  "GET",
  "/api/events",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const events = yield* EventStream;
    const cursor =
      request.headers["last-event-id"] ??
      new URL(request.url, "http://localhost").searchParams.get("after") ??
      undefined;
    const frames = events.connect(cursor === "" ? undefined : cursor).pipe(Stream.map(encodeFrame));
    // Browsers wait a second before reconnecting.
    return HttpServerResponse.stream(Stream.succeed("retry: 1000\n\n").pipe(Stream.concat(frames), Stream.encodeText), {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  }),
);

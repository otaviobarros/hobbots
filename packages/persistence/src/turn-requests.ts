import type { HobbotsRepository } from "@hobbots/agents";
import {
  type Actor,
  type JournaledEvent,
  type Line,
  Message,
  type MessageId,
  QueuedMessageTransitions,
  type TurnRequest,
  type TurnRequestId,
  TurnRequests,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import type { makeJournaled, makeJournaledChange } from "./journal.ts";
import { relaysFor } from "./relays.ts";
import {
  insertRequest,
  selectOpenRequests,
  selectOpenRequestsOf,
  selectRequestsById,
  selectRequestsIn,
  selectRequestsOfReply,
  selectThreadsWaiting,
  stepRequests,
} from "./turn-request-rows.ts";

// The floor's writes (ADR 039, One hob speaks at a time): a request speaks in the transaction that
// saves its turn's reply, is answered when the turn ends, with the relays its reply's mentions
// cause, and is dropped by Stop and Stop all. A queued message left with nothing owed leaves the
// queue as it is, said but answered by no one. Let them go on wakes the requests the relay budget
// paused.

type Writes = Pick<
  HobbotsRepository["Service"],
  | "openTurnRequests"
  | "startReply"
  | "answerTurnRequests"
  | "letHobsGoOn"
  | "dropTurnRequests"
  | "answerUnfinishedTurnRequests"
  | "threadsWithWaitingRequests"
>;

/**
 * Moves `ids` to speaking for `replyId`, or fails `NotWaiting` when any no longer waits (Stop all
 * dropped it meanwhile), so the turn does not start.
 */
export const speakFor = (sql: SqlClient.SqlClient, ids: ReadonlyArray<TurnRequestId>, replyId: MessageId) =>
  Effect.gen(function* () {
    const found = yield* selectRequestsById(sql, ids);
    if (found.length !== ids.length || !found.every(TurnRequests.isWaiting)) return false;
    yield* stepRequests(sql, found, { _tag: "Speak", replyId });
    return true;
  });

/**
 * The turn writing `replyId` ended: its speaking requests are answered, and the reply as its turn
 * left it relays to the hobs it mentions, once.
 */
const answerRelaying =
  (
    sql: SqlClient.SqlClient,
    readMessage: (id: MessageId) => Effect.Effect<Option.Option<Message>, SqlError.SqlError>,
  ) =>
  (replyId: MessageId) =>
    Effect.gen(function* () {
      const own = yield* selectRequestsOfReply(sql, replyId);
      yield* stepRequests(sql, own.filter(TurnRequests.isSpeaking), { _tag: "Answer" });
      const reply = yield* readMessage(replyId);
      if (Option.isNone(reply)) return;
      for (const relay of yield* relaysFor(sql, reply.value, own)) yield* insertRequest(sql, relay);
    });

export const makeTurnRequestWrites = (
  sql: SqlClient.SqlClient,
  journaled: ReturnType<typeof makeJournaled>,
  journaledChange: ReturnType<typeof makeJournaledChange>,
  writeMessage: (message: Message) => Effect.Effect<Message, SqlError.SqlError>,
  readMessage: (id: MessageId) => Effect.Effect<Option.Option<Message>, SqlError.SqlError>,
  messageEvents: (message: Message) => ReadonlyArray<JournaledEvent>,
): Writes => {
  const answerAndRelay = answerRelaying(sql, readMessage);
  // The queued messages among `messageIds` that nothing is owed for any more, which leave the queue
  // complete, where they were: what was said stays, and no turn answers it.
  const dequeueUnowed = (messageIds: ReadonlyArray<MessageId>, revision: number) =>
    Effect.gen(function* () {
      const owed = new Set((yield* selectOpenRequestsOf(sql, "message_id", messageIds)).map((r) => r.messageId));
      const events: Array<JournaledEvent> = [];
      for (const messageId of new Set(messageIds)) {
        if (owed.has(messageId)) continue;
        const found = yield* readMessage(messageId);
        if (Option.isNone(found)) continue;
        const said = QueuedMessageTransitions.drop(found.value);
        if (!(said instanceof Message)) continue;
        const message = new Message({ ...said, revision: revision + events.length });
        yield* sql`UPDATE messages SET status = ${message.status}, revision = ${message.revision}
          WHERE id = ${messageId} AND status = 'queued'`;
        events.push(
          { _tag: "MessageUpserted", message },
          { _tag: "MessageDequeued", threadId: message.threadId, messageId, reason: "dropped" },
        );
      }
      return events;
    });

  return {
    openTurnRequests: (line) => selectOpenRequests(sql, line).pipe(Effect.orDie),
    startReply: (reply, speaking) =>
      journaled(messageEvents(reply).length, (first) =>
        Effect.gen(function* () {
          if (!(yield* speakFor(sql, speaking, reply.id))) return null;
          const saved = yield* writeMessage(new Message({ ...reply, revision: first }));
          return { value: saved, events: messageEvents(saved) };
        }),
      ),
    // Under the journal's lock, as Stop all's drop is, so a stop either drops the speaking request
    // before the turn answers it, and the reply relays nothing, or finds the relays it wrote.
    answerTurnRequests: (replyId) =>
      journaledChange<void, never>(() =>
        answerAndRelay(replyId).pipe(Effect.as({ value: undefined, events: [] })),
      ).pipe(Effect.asVoid),
    letHobsGoOn: (line: Line, by: Actor) =>
      journaledChange<ReadonlyArray<TurnRequest>, never>(() =>
        Effect.gen(function* () {
          const woken = yield* stepRequests(sql, TurnRequests.paused(yield* selectOpenRequests(sql, line)), {
            _tag: "GoOn",
          });
          const events: ReadonlyArray<JournaledEvent> =
            woken.length === 0
              ? []
              : [
                  {
                    _tag: "RelayBudgetReset",
                    threadId: line.threadId,
                    rootMessageId: line.rootMessageId,
                    by,
                    requests: woken.map((request) => request.id),
                  },
                ];
          return { value: woken, events };
        }),
      ),
    dropTurnRequests: (ids: ReadonlyArray<TurnRequestId>, by: Actor | null) =>
      journaledChange<ReadonlyArray<TurnRequest>, never>((revision) =>
        Effect.gen(function* () {
          const asked = yield* selectRequestsById(sql, ids);
          // A turn that ended after the requests were picked answered its own and relayed: what its
          // reply now owes is dropped with them, so a stop misses nothing owed since (ADR 039).
          const replies = asked.flatMap((request) => (request.replyId === null ? [] : [request.replyId]));
          const relayed = yield* selectOpenRequestsOf(sql, "message_id", replies);
          const picked = new Set(asked.map((request) => request.id));
          const owed = [...asked, ...relayed.filter((request) => !picked.has(request.id))];
          const dropped = yield* stepRequests(sql, owed, { _tag: "Drop", by });
          const events = yield* dequeueUnowed(
            dropped.map((request) => request.messageId),
            revision,
          );
          return { value: dropped, events };
        }),
      ),
    // A turn that was speaking when the hub stopped was ended as an interrupted reply, which Continue
    // resumes; that reply is its answer, so its request does not start a second turn.
    // A reply saved complete just before the hub stopped still relays its mentions, as its turn's
    // end would have; an interrupted one relays nothing.
    answerUnfinishedTurnRequests: selectRequestsIn(sql, "speaking").pipe(
      Effect.flatMap((speaking) =>
        Effect.forEach(new Set(speaking.flatMap((request) => request.replyId ?? [])), answerAndRelay, {
          discard: true,
        }),
      ),
      sql.withTransaction,
      Effect.orDie,
    ),
    threadsWithWaitingRequests: selectThreadsWaiting(sql).pipe(Effect.orDie),
  };
};

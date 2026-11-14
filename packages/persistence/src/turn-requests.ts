import { type HobbotsRepository, passStands } from "@hobbots/agents";
import { ThreadArchived } from "@hobbots/api";
import {
  type Actor,
  isActiveMember,
  type JournaledEvent,
  MemberRefused,
  Message,
  type MessageId,
  planMemberRemove,
  QueuedMessageTransitions,
  type Thread,
  type ThreadId,
  type ThreadMember,
  type TurnRequest,
  type TurnRequestId,
  TurnRequests,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import type { makeJournaled, makeJournaledChange } from "./journal.ts";
import { movedMember, saveState, selectMembers } from "./thread-member-rows.ts";
import {
  selectOpenRequests,
  selectOpenRequestsOf,
  selectRequestsById,
  selectRequestsIn,
  selectThreadsWaiting,
  selectWaitingOf,
  stepRequests,
} from "./turn-request-rows.ts";

// The floor's writes (ADR 039, One hob speaks at a time): a request speaks in the transaction that
// saves its turn's reply, is answered when the turn ends, and is dropped by Stop and Stop all. A
// queued message left with nothing owed leaves the queue as it is, said but answered by no one.

type Writes = Pick<
  HobbotsRepository["Service"],
  | "openTurnRequests"
  | "startReply"
  | "answerTurnRequests"
  | "turnRequestsOf"
  | "passTurnRequests"
  | "markPassing"
  | "passedConfigVersions"
  | "dropTurnRequests"
  | "answerUnfinishedTurnRequests"
  | "threadsWithWaitingRequests"
  | "removeMember"
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

export const makeTurnRequestWrites = (
  sql: SqlClient.SqlClient,
  journaled: ReturnType<typeof makeJournaled>,
  journaledChange: ReturnType<typeof makeJournaledChange>,
  writeMessage: (message: Message) => Effect.Effect<Message, SqlError.SqlError>,
  readMessage: (id: MessageId) => Effect.Effect<Option.Option<Message>, SqlError.SqlError>,
  messageEvents: (message: Message) => ReadonlyArray<JournaledEvent>,
): Writes => {
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

  // Whether `hobId` leads a top-level Quest in the thread that has not ended.
  const leadsOpenQuest = (threadId: ThreadId, hobId: string) =>
    sql`SELECT 1 FROM tasks WHERE thread_id = ${threadId} AND owner_id = ${hobId} AND parent_id IS NULL
      AND state NOT IN ('completed', 'failed', 'cancelled') LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

  // Drops every request `hobId` still waits to answer in the thread, on any of its lines.
  const dropWaitingOf = (threadId: ThreadId, hobId: string, by: Actor) =>
    selectWaitingOf(sql, threadId, hobId).pipe(
      Effect.flatMap((waiting) => stepRequests(sql, waiting, { _tag: "Drop", by })),
    );

  // Passes `speaking`, the requests the turn writing `replyId` spoke for, and removes the reply, so a
  // pass leaves no message (ADR 039). What the turn used stays in `passed_turns` (OP-002), and a
  // request the reply's own text caused goes with it. A reply an approval names stays, since that
  // record needs it, and its requests are answered instead.
  const passReply = (replyId: MessageId, speaking: ReadonlyArray<TurnRequest>, reason: string) =>
    Effect.gen(function* () {
      const none = { value: [] as ReadonlyArray<TurnRequest>, events: [] as ReadonlyArray<JournaledEvent> };
      if (speaking.length === 0) return none;
      const named = yield* sql`SELECT 1 AS named FROM approval_requests WHERE message_id = ${replyId}`;
      if (named.length > 0) {
        yield* stepRequests(sql, speaking, { _tag: "Answer" });
        return none;
      }
      yield* sql`INSERT INTO passed_turns (reply_id, thread_id, agent_id, runtime, model, config_version, created_at,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
        SELECT id, thread_id, actor_id, runtime, model, config_version, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens
        FROM messages WHERE id = ${replyId}`;
      yield* sql`DELETE FROM messages WHERE id = ${replyId}`;
      const passed = yield* stepRequests(sql, speaking, { _tag: "Pass", reason });
      yield* stepRequests(sql, yield* selectOpenRequestsOf(sql, "message_id", [replyId]), { _tag: "Drop", by: null });
      const events = passed.map(
        (request): JournaledEvent => ({ _tag: "TurnPassed", threadId: request.threadId, messageId: replyId, request }),
      );
      return { value: passed, events };
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
    answerTurnRequests: (replyId) =>
      selectOpenRequestsOf(sql, "reply_id", [replyId]).pipe(
        Effect.flatMap((speaking) => stepRequests(sql, speaking.filter(TurnRequests.isSpeaking), { _tag: "Answer" })),
        sql.withTransaction,
        Effect.asVoid,
        Effect.orDie,
      ),
    turnRequestsOf: (replyId) => selectOpenRequestsOf(sql, "reply_id", [replyId]).pipe(Effect.orDie),
    markPassing: (replyId, reason) =>
      sql`UPDATE turn_requests SET pass_reason = ${reason}
        WHERE reply_id = ${replyId} AND state = 'speaking'`.pipe(Effect.asVoid, Effect.orDie),
    passTurnRequests: (replyId, reason) =>
      journaledChange<ReadonlyArray<TurnRequest>, never>(() =>
        Effect.gen(function* () {
          const speaking = (yield* selectOpenRequestsOf(sql, "reply_id", [replyId])).filter(TurnRequests.isSpeaking);
          return yield* passReply(replyId, speaking, reason);
        }),
      ),
    dropTurnRequests: (ids: ReadonlyArray<TurnRequestId>, by: Actor | null) =>
      journaledChange<ReadonlyArray<TurnRequest>, never>((revision) =>
        Effect.gen(function* () {
          const dropped = yield* stepRequests(sql, yield* selectRequestsById(sql, ids), { _tag: "Drop", by });
          const events = yield* dequeueUnowed(
            dropped.map((request) => request.messageId),
            revision,
          );
          return { value: dropped, events };
        }),
      ),
    // A turn that was speaking when the hub stopped was ended as an interrupted reply, which Continue
    // resumes; that reply is its answer, so its request does not start a second turn. A turn whose
    // hob had passed passes now, as its end would have, unless its reply holds text or work a removed
    // reply would hide: steps after the pass, or any a continued reply carried from before, keep it.
    answerUnfinishedTurnRequests: journaledChange<void, never>(() =>
      Effect.gen(function* () {
        const speaking = yield* selectRequestsIn(sql, "speaking");
        const events: Array<JournaledEvent> = [];
        for (const replyId of new Set(speaking.flatMap((request) => request.replyId ?? []))) {
          const turn = speaking.filter((request) => request.replyId === replyId);
          const reason = turn.find((request) => request.passReason !== null)?.passReason ?? null;
          const reply = yield* readMessage(replyId);
          const stands = reason !== null && Option.isSome(reply) && passStands(reply.value, 0);
          if (!stands) yield* stepRequests(sql, turn, { _tag: "Answer" });
          else events.push(...(yield* passReply(replyId, turn, reason)).events);
        }
        yield* stepRequests(
          sql,
          speaking.filter((request) => request.replyId === null),
          { _tag: "Answer" },
        );
        return { value: undefined, events };
      }),
    ),
    threadsWithWaitingRequests: selectThreadsWaiting(sql).pipe(Effect.orDie),
    removeMember: (threadId, actor, by) =>
      journaledChange<
        { readonly member: ThreadMember; readonly dropped: ReadonlyArray<TurnRequest> },
        MemberRefused | ThreadArchived
      >((revision) =>
        Effect.gen(function* () {
          const [thread] = yield* sql<Pick<Thread, "kind" | "agentId" | "archivedAt">>`SELECT kind, agent_id,
            archived_at FROM threads WHERE id = ${threadId}`;
          if (thread === undefined) return yield* Effect.die(new Error(`No thread ${threadId}`));
          // A camp archived since it was read is read-only by the time this is written.
          if (thread.archivedAt !== null) {
            return yield* new ThreadArchived({ threadId, archivedAt: thread.archivedAt });
          }
          const members = yield* selectMembers(sql, threadId);
          // A person must still be in the camp as the change is written, not only when it was asked.
          if (by.kind === "user" && !isActiveMember(members, by)) {
            return yield* new MemberRefused({ threadId, actor: by, reason: "not-member" });
          }
          const plan = planMemberRemove(thread, members, actor);
          if (plan._tag === "refused") return yield* new MemberRefused({ threadId, actor, reason: plan.reason });
          if (plan._tag === "gone") return { value: { member: plan.member, dropped: [] }, events: [] };
          // A Quest the hob leads here still comes back to the camp for its results and answers.
          if (actor.kind === "hob" && (yield* leadsOpenQuest(threadId, actor.id))) {
            return yield* new MemberRefused({ threadId, actor, reason: "leads-quest" });
          }
          const member = movedMember(plan.member, { _tag: "Remove" }, revision);
          yield* saveState(sql, member);
          // The hob owes nothing here any more: what it was waiting to answer, on any line, is dropped
          // with it. The answer it is speaking now ends with its turn.
          const dropped = actor.kind === "hob" ? yield* dropWaitingOf(threadId, actor.id, by) : [];
          const dequeued = yield* dequeueUnowed(
            dropped.map((request) => request.messageId),
            revision + 1,
          );
          const events: ReadonlyArray<JournaledEvent> = [{ _tag: "ThreadMemberChanged", member }, ...dequeued];
          return { value: { member, dropped }, events };
        }),
      ),
    passedConfigVersions: (threadId, agentId) =>
      sql<{ readonly configVersion: number }>`SELECT DISTINCT config_version FROM passed_turns
        WHERE thread_id = ${threadId} AND agent_id = ${agentId} AND config_version IS NOT NULL`.pipe(
        Effect.map((rows) => rows.map((row) => Number(row.configVersion))),
        Effect.orDie,
      ),
  };
};

import {
  type Message,
  relayDepthAfter,
  type ThreadKind,
  ThreadMembers,
  type TurnRequest,
  TurnRequests,
} from "@hobbots/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { answerersIn } from "./answerer-reads.ts";
import { selectMembers } from "./thread-member-rows.ts";
import { requestsFor, selectRequestsOfReply } from "./turn-request-rows.ts";

// Hobs talking to hobs (ADR 039; #1463): a hob's reply that @mentions another hob of the camp owes
// that hob an answer, as a person's mention does. Each such request is one relay deeper than the
// turn that wrote the reply, and one past the relay budget is written paused, waiting for a person.

/**
 * The relay requests `reply` causes as it is saved complete, read with the requests its turn spoke
 * for and those it already caused, in any state. None for a reply that is not a hob's complete chat
 * reply, that a lead kept quiet, whose turn was stopped, or that already relayed. Only an active
 * member hob of the thread is relayed to: a mention of any other hob, or of a person, wakes nobody.
 */
export const relaysFor = (
  sql: SqlClient.SqlClient,
  reply: Message,
): Effect.Effect<ReadonlyArray<TurnRequest>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const author = reply.actor;
    if (reply.role !== "assistant" || reply.status !== "complete" || reply.quiet || author?.kind !== "hob") return [];
    const own = yield* selectRequestsOfReply(sql, reply.id);
    const spoken = own.filter((request) => request.replyId === reply.id);
    // Stop dropped the turn's request, and the reply relays once.
    if (spoken.some(TurnRequests.isDropped)) return [];
    if (own.some((request) => request.messageId === reply.id)) return [];
    const members = yield* selectMembers(sql, reply.threadId);
    const camp = new Set(
      members.filter((member) => member.actor.kind === "hob" && ThreadMembers.isActive(member)).map((m) => m.actor.id),
    );
    const mentions = reply.mentions.filter(
      (actor) => actor.kind === "hob" && actor.id !== author.id && camp.has(actor.id),
    );
    if (mentions.length === 0) return [];
    const [thread] = yield* sql<{ readonly kind: ThreadKind }>`SELECT kind FROM threads WHERE id = ${reply.threadId}`;
    if (thread === undefined) return [];
    const answerers = yield* answerersIn(
      sql,
      { id: reply.threadId, kind: thread.kind },
      { role: reply.role, actor: author, mentions, repliesTo: null },
    ).pipe(Effect.catchTag("MentionRefused", () => Effect.succeed([])));
    return requestsFor(reply, author, answerers, relayDepthAfter(spoken));
  });

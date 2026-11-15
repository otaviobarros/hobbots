import {
  type ChannelKind,
  ChannelMembers,
  isStopAsked,
  type Message,
  type MessageId,
  type MessageStatus,
  relayDepthAfter,
  type TurnRequest,
  TurnRequests,
} from "@hobbots/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { answerersIn } from "./answerer-reads.ts";
import { selectMembers } from "./channel-member-rows.ts";
import { requestsFor, selectRequestsOfReply } from "./turn-request-rows.ts";

// Hobs talking to hobs (ADR 039; #1463): a hob's reply that @mentions another hob of the camp owes
// that hob an answer, as a person's mention does. Each such request is one relay deeper than the
// turn that wrote the reply, and one past the relay budget is written paused, waiting for a person.

/**
 * The relay requests `reply` causes as it is saved complete, read with the requests its turn spoke
 * for and those it already caused, in any state. None for a reply that is not a hob's complete chat
 * reply, that a lead kept quiet, whose turn was stopped, or that already relayed. Only an active
 * member hob of the channel is relayed to: a mention of any other hob, or of a person, wakes nobody.
 */
/** Whether `message` is a hob's chat reply saved complete and not kept quiet, before its mentions are read. */
export const mayComplete = (message: Message): boolean =>
  message.role === "assistant" && message.status === "complete" && !message.quiet && message.actor?.kind === "hob";

/** Whether `message` is a hob's complete chat reply that mentions another hob, the only kind that relays. */
export const mayRelay = (message: Message): boolean =>
  mayComplete(message) && message.mentions.some((actor) => actor.kind === "hob" && actor.id !== message.actor?.id);

/**
 * Whether the reply stored as `replyId` is one you asked to stop, read before it is saved again: a
 * stop of a turn that answers no request, as a carried backpack's, leaves no dropped request to say so.
 */
export const stopWasAsked = (sql: SqlClient.SqlClient, replyId: MessageId) =>
  sql<{ readonly status: MessageStatus }>`SELECT status FROM messages WHERE id = ${replyId}`.pipe(
    Effect.map(([row]) => row !== undefined && isStopAsked(row.status)),
  );

export const relaysFor = (
  sql: SqlClient.SqlClient,
  reply: Message,
): Effect.Effect<ReadonlyArray<TurnRequest>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const author = reply.actor;
    if (!mayRelay(reply) || author?.kind !== "hob") return [];
    const own = yield* selectRequestsOfReply(sql, reply.id);
    const spoken = own.filter((request) => request.replyId === reply.id);
    // Stop dropped the turn's request, and the reply relays once.
    if (spoken.some(TurnRequests.isDropped)) return [];
    if (own.some((request) => request.messageId === reply.id)) return [];
    const members = yield* selectMembers(sql, reply.channelId);
    const camp = new Set(
      members.filter((member) => member.actor.kind === "hob" && ChannelMembers.isActive(member)).map((m) => m.actor.id),
    );
    const mentions = reply.mentions.filter(
      (actor) => actor.kind === "hob" && actor.id !== author.id && camp.has(actor.id),
    );
    if (mentions.length === 0) return [];
    const [channel] = yield* sql<{
      readonly kind: ChannelKind;
    }>`SELECT kind FROM channels WHERE id = ${reply.channelId}`;
    if (channel === undefined) return [];
    const answerers = yield* answerersIn(
      sql,
      { id: reply.channelId, kind: channel.kind },
      { role: reply.role, actor: author, mentions, repliesTo: null },
    ).pipe(Effect.catchTag("MentionRefused", () => Effect.succeed([])));
    return requestsFor(reply, author, answerers, relayDepthAfter(spoken));
  });

import {
  AgentId,
  type AnswerOwed,
  type AnswerPlace,
  answerersFor,
  type Channel,
  type ChannelId,
  isActiveQuest,
  MentionRefused,
  QuestState,
  type RunningQuest,
  type SaidMessage,
} from "@hobbots/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { selectMembers } from "./channel-member-rows.ts";

// What `answerersFor` reads (ADR 039, Who answers), read inside the transaction that stores the
// message, so a member added or a Quest started at the same moment is either seen or comes after.

const RUNNING = QuestState.literals.filter(isActiveQuest);

/** The latest top Quest under way in the channel, with the hobs it brought in, or null. */
const runningQuest = (sql: SqlClient.SqlClient, channelId: ChannelId) =>
  Effect.gen(function* () {
    const [quest] = yield* sql<{ readonly id: string; readonly leadId: string }>`SELECT id, lead_id FROM quests
      WHERE channel_id = ${channelId} AND parent_quest_id IS NULL AND ${sql.in("state", RUNNING)}
      ORDER BY created_at DESC, id DESC LIMIT 1`;
    if (quest === undefined) return null;
    const party = yield* sql<{ readonly memberId: string }>`SELECT member_id FROM delegations
      WHERE quest_id = ${quest.id} ORDER BY created_at, id`;
    return {
      leadId: AgentId.make(quest.leadId),
      party: [...new Set(party.map((row) => row.memberId))].map((id) => AgentId.make(id)),
    } satisfies RunningQuest;
  });

/**
 * Who answers `said` in the channel, from its members and its running Quest as they stand now in
 * the caller's transaction, or `MentionRefused`.
 */
export const answerersIn = (
  sql: SqlClient.SqlClient,
  channel: Pick<Channel, "id" | "kind">,
  said: SaidMessage,
): Effect.Effect<ReadonlyArray<AnswerOwed>, MentionRefused | SqlError.SqlError> =>
  Effect.gen(function* () {
    const place: AnswerPlace = { id: channel.id, kind: channel.kind, quest: yield* runningQuest(sql, channel.id) };
    const decided = answerersFor(said, place, yield* selectMembers(sql, channel.id));
    return decided instanceof MentionRefused ? yield* decided : decided;
  });

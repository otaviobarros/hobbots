import {
  AgentId,
  type AnswerOwed,
  type AnswerPlace,
  answerersFor,
  isActiveQuest,
  MentionRefused,
  QuestState,
  type RunningQuest,
  type SaidMessage,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { selectMembers } from "./thread-member-rows.ts";

// What `answerersFor` reads (ADR 039, Who answers), read inside the transaction that stores the
// message, so a member added or a Quest started at the same moment is either seen or comes after.

const RUNNING = QuestState.literals.filter(isActiveQuest);

/** The latest top Quest under way in the thread, with the hobs it brought in, or null. */
const runningQuest = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    const [quest] = yield* sql<{ readonly id: string; readonly leadId: string }>`SELECT id, lead_id FROM quests
      WHERE thread_id = ${threadId} AND parent_quest_id IS NULL AND ${sql.in("state", RUNNING)}
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
 * Who answers `said` in the thread, from its members and its running Quest as they stand now in
 * the caller's transaction, or `MentionRefused`.
 */
export const answerersIn = (
  sql: SqlClient.SqlClient,
  thread: Pick<Thread, "id" | "kind">,
  said: SaidMessage,
): Effect.Effect<ReadonlyArray<AnswerOwed>, MentionRefused | SqlError.SqlError> =>
  Effect.gen(function* () {
    const place: AnswerPlace = { id: thread.id, kind: thread.kind, quest: yield* runningQuest(sql, thread.id) };
    const decided = answerersFor(said, place, yield* selectMembers(sql, thread.id));
    return decided instanceof MentionRefused ? yield* decided : decided;
  });

import {
  type AgentId,
  type ApprovalState,
  type QuestId,
  type QuestionState,
  type QuestState,
  questSummaryOf,
  type TaskId,
  type TaskState,
  type ThreadId,
} from "@hobbots/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// How each Quest is going, as the hub publishes it (ADR 037, #1373): one row per Quest, rewritten in
// the transaction of every change that gives its Quest another summary, and journaled as
// `QuestSummaryChanged` only then. Clients read it instead of folding Task states themselves.
//
// Every Quest already stored gets its summary now, folded from its tree as the hub folds it, at the
// journal's head: no `QuestSummaryChanged` is journaled for it, since nothing changed, and the
// revision of its next change is higher. Its ready-for-review count is 0105's.

type Row = Record<string, unknown>;

const text = (value: unknown) => (value == null ? null : String(value));

export default Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  yield* sql`CREATE TABLE quest_summaries (
    quest_id TEXT PRIMARY KEY REFERENCES quests(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    lead_id TEXT NOT NULL,
    parent_quest_id TEXT,
    thread_id TEXT,
    state TEXT NOT NULL,
    needs INTEGER NOT NULL,
    working INTEGER NOT NULL,
    waiting INTEGER NOT NULL,
    done INTEGER NOT NULL,
    problem INTEGER NOT NULL,
    idle INTEGER NOT NULL,
    needs_you INTEGER NOT NULL,
    ready_for_review INTEGER NOT NULL,
    revision BIGINT NOT NULL
  )`;
  yield* sql`CREATE INDEX quest_summaries_thread ON quest_summaries (thread_id)`;
  yield* sql`CREATE INDEX quest_summaries_state ON quest_summaries (state)`;

  const [head] = yield* sql<Row>`SELECT sequence FROM event_journal_head WHERE id = 1`;
  const revision = Number(head?.sequence ?? 0);
  const roots = yield* sql<Row>`SELECT DISTINCT t.root_id FROM quests q JOIN tasks t ON t.id = q.task_id`;
  for (const root of roots) {
    const rootId = String(root.root_id);
    const tasks = (yield* sql<Row>`SELECT id, parent_id, state FROM tasks WHERE root_id = ${rootId}`).map((row) => ({
      id: String(row.id) as TaskId,
      parentId: text(row.parent_id) as TaskId | null,
      state: String(row.state) as TaskState,
    }));
    const inTree = sql`task_id IN (SELECT id FROM tasks WHERE root_id = ${rootId})`;
    const quests = yield* sql<Row>`SELECT * FROM quests WHERE ${inTree}`;
    const tree = {
      tasks,
      questions: (yield* sql<Row>`SELECT task_id, recipient_id, state FROM questions
        WHERE ${inTree} AND state = 'open'`).map((row) => ({
        taskId: String(row.task_id) as TaskId,
        recipientId: text(row.recipient_id) as AgentId | null,
        state: String(row.state) as QuestionState,
      })),
      approvals: (yield* sql<Row>`SELECT task_id, state FROM approval_requests
        WHERE ${inTree} AND state = 'pending'`).map((row) => ({
        taskId: String(row.task_id) as TaskId,
        state: String(row.state) as ApprovalState,
      })),
      // What is ready for review is counted by 0105, once artifacts have a review (#1422).
      delivered: [],
    };
    for (const quest of quests) {
      const summary = questSummaryOf(
        {
          id: String(quest.id) as QuestId,
          taskId: String(quest.task_id) as TaskId,
          leadId: String(quest.lead_id) as AgentId,
          parentQuestId: text(quest.parent_quest_id) as QuestId | null,
          threadId: text(quest.thread_id) as ThreadId | null,
          state: String(quest.state) as QuestState,
        },
        tree,
      );
      yield* sql`INSERT INTO quest_summaries ${sql.insert({
        quest_id: summary.questId,
        task_id: summary.taskId,
        lead_id: summary.leadId,
        parent_quest_id: summary.parentQuestId,
        thread_id: summary.threadId,
        state: summary.state,
        ...summary.tones,
        needs_you: summary.needsYou,
        ready_for_review: summary.readyForReview,
        revision,
      })}`;
    }
  }
});

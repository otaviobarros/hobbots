import {
  AgentId,
  ApprovalState,
  ArtifactKind,
  type JournaledEvent,
  type Quest,
  QuestionState,
  QuestSummary,
  type QuestSummaryFields,
  questSummaryOf,
  type SummaryTree,
  sameSummary,
  TaskId,
  type ThreadId,
} from "@hobbots/domain";
import { Effect, Schema } from "effect";
import type { SqlClient, SqlError, Statement } from "effect/sql";
import { byteOrder } from "./order.ts";
import { makeTaskReads } from "./task-rows.ts";

/**
 * The hub's Quest summaries (ADR 037, migration 0103): one row per Quest, rewritten in the
 * transaction of every change that gives its Quest another summary, with its `QuestSummaryChanged`.
 */

/** A row of `quest_summaries`, as the SQL client reads it. */
interface SummaryRow {
  readonly questId: string;
  readonly taskId: string;
  readonly leadId: string;
  readonly parentQuestId: string | null;
  readonly threadId: string | null;
  readonly state: string;
  readonly needs: number | string;
  readonly working: number | string;
  readonly waiting: number | string;
  readonly done: number | string;
  readonly problem: number | string;
  readonly idle: number | string;
  readonly needsYou: number | string;
  readonly readyForReview: number | string;
  readonly revision: number | string;
}

const decode = Schema.decodeUnknownEffect(QuestSummary);

// PostgreSQL reads INTEGER and BIGINT columns as bigints or strings; every count fits a number.
const summaryFromRow = (row: SummaryRow) =>
  decode({
    questId: row.questId,
    taskId: row.taskId,
    leadId: row.leadId,
    parentQuestId: row.parentQuestId,
    threadId: row.threadId,
    state: row.state,
    tones: {
      needs: Number(row.needs),
      working: Number(row.working),
      waiting: Number(row.waiting),
      done: Number(row.done),
      problem: Number(row.problem),
      idle: Number(row.idle),
    },
    needsYou: Number(row.needsYou),
    readyForReview: Number(row.readyForReview),
    revision: Number(row.revision),
  }).pipe(Effect.orDie);

/** The columns a summary is stored in. */
const summaryColumns = (summary: QuestSummaryFields, revision: number) => ({
  quest_id: summary.questId,
  task_id: summary.taskId,
  lead_id: summary.leadId,
  parent_quest_id: summary.parentQuestId,
  thread_id: summary.threadId,
  state: summary.state,
  needs: summary.tones.needs,
  working: summary.tones.working,
  waiting: summary.tones.waiting,
  done: summary.tones.done,
  problem: summary.tones.problem,
  idle: summary.tones.idle,
  needs_you: summary.needsYou,
  ready_for_review: summary.readyForReview,
  revision,
});

// Rows the hub wrote: one that does not decode is a defect.
const decodeRows =
  <S extends Schema.Top>(schema: S) =>
  (rows: unknown) =>
    Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie);
const questionRows = decodeRows(
  Schema.Struct({ taskId: TaskId, recipientId: Schema.NullOr(AgentId), state: QuestionState }),
);
const approvalRows = decodeRows(Schema.Struct({ taskId: Schema.NullOr(TaskId), state: ApprovalState }));
const artifactRows = decodeRows(Schema.Struct({ taskId: TaskId, kind: ArtifactKind, value: Schema.String }));

/**
 * The Tasks a change's events touch in a way a summary reads: a Task's state, a Quest starting or
 * ending, a question reaching you or leaving, an approval waiting or decided. A chat started fresh
 * moves the open Quests of the chat it replaced into it, so the thread of each changes.
 */
const touchedTasks = (sql: SqlClient.SqlClient, events: ReadonlyArray<JournaledEvent>) =>
  Effect.gen(function* () {
    const ids = new Set<string>();
    const moved: Array<ThreadId> = [];
    for (const event of events) {
      if ("task" in event) ids.add(event.task.id);
      else if (event._tag === "QuestStarted" || event._tag === "QuestCompleted") ids.add(event.quest.taskId);
      else if ("question" in event) ids.add(event.question.taskId);
      else if ("approval" in event && event.approval.taskId !== null) ids.add(event.approval.taskId);
      else if (event._tag === "ChatStartedFresh") moved.push(event.chat.id);
    }
    if (moved.length > 0) {
      const rows = yield* sql<{
        readonly taskId: string;
      }>`SELECT task_id FROM quests WHERE ${sql.in("thread_id", moved)}`;
      for (const row of rows) ids.add(row.taskId);
    }
    return [...ids];
  });

/** What the summaries of a tree's Quests are folded from, beside its Tasks: what waits on you, and links its Tasks returned. */
const summaryTree = (sql: SqlClient.SqlClient, tasks: SummaryTree["tasks"]) =>
  Effect.gen(function* () {
    const ids = tasks.map((task) => task.id);
    const questions = yield* sql`SELECT task_id, recipient_id, state FROM questions
      WHERE ${sql.in("task_id", ids)} AND state = 'open'`.pipe(Effect.flatMap(questionRows));
    const approvals = yield* sql`SELECT task_id, state FROM approval_requests
      WHERE ${sql.in("task_id", ids)} AND state = 'pending'`.pipe(Effect.flatMap(approvalRows));
    const artifacts = yield* sql`SELECT task_id, kind, value FROM artifact_refs
      WHERE ${sql.in("task_id", ids)} AND kind = 'link'`.pipe(Effect.flatMap(artifactRows));
    return { tasks, questions, approvals, artifacts } satisfies SummaryTree;
  });

/**
 * Folds the summary of every Quest in the trees the events touch, and writes and journals each that
 * changed, at journal sequences from `first` on: its `QuestSummaryChanged` events. A summary that
 * says what it said before is neither written nor journaled. Only for use within
 * `sql.withTransaction`, after the change and the rest of what it calls for wrote.
 */
export const refreshQuestSummaries = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const touched = yield* touchedTasks(sql, events);
    if (touched.length === 0) return [];
    const read = makeTaskReads(sql);
    const rows = yield* sql<{ readonly rootId: string }>`SELECT root_id FROM tasks
      WHERE ${sql.in("id", touched)} ORDER BY ${byteOrder(sql, ["root_id"])}`;
    const folded: Array<QuestSummaryFields> = [];
    for (const rootId of new Set(rows.map((row) => row.rootId))) {
      // Most trees hold no Quest: a Task worked on alone has no summary to fold.
      const [led] = yield* sql`SELECT id FROM quests
        WHERE task_id IN (SELECT id FROM tasks WHERE root_id = ${rootId}) LIMIT 1`;
      if (led === undefined) continue;
      const tasks = yield* read.treeOf(rootId);
      const quests: ReadonlyArray<Quest> = yield* read.questsOn(tasks.map((task) => task.id));
      const tree = yield* summaryTree(sql, tasks);
      folded.push(...quests.map((quest) => questSummaryOf(quest, tree)));
    }
    if (folded.length === 0) return [];
    const stored = new Map(
      (yield* listSummaries(
        sql,
        sql.in(
          "quest_id",
          folded.map((summary) => summary.questId),
        ),
      )).map((summary) => [summary.questId, summary]),
    );
    const changed = folded.filter((summary) => {
      const before = stored.get(summary.questId);
      return before === undefined || !sameSummary(before, summary);
    });
    return yield* Effect.forEach(changed, (fields, index) =>
      Effect.gen(function* () {
        const revision = first + index;
        const { quest_id, ...columns } = summaryColumns(fields, revision);
        yield* stored.has(fields.questId)
          ? sql`UPDATE quest_summaries SET ${sql.update(columns)} WHERE quest_id = ${quest_id}`
          : sql`INSERT INTO quest_summaries ${sql.insert({ quest_id, ...columns })}`;
        return { _tag: "QuestSummaryChanged", summary: new QuestSummary({ ...fields, revision }) } as const;
      }),
    );
  });

/** The stored summaries `where` picks, oldest Quest first. */
const listSummaries = (sql: SqlClient.SqlClient, where: Statement.Fragment) =>
  sql<SummaryRow>`SELECT s.* FROM quest_summaries s JOIN quests q ON q.id = s.quest_id
    WHERE ${where} ORDER BY ${byteOrder(sql, ["q.created_at", "q.id"])}`.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, summaryFromRow)),
  );

/**
 * The summaries the sync snapshot serves: with a thread, every Quest followed in it, ended ones
 * included; without one, every Quest still active. Oldest Quest first.
 */
export const readQuestSummaries = (sql: SqlClient.SqlClient, threadId: ThreadId | null) =>
  listSummaries(sql, threadId === null ? sql`s.state = 'active'` : sql`s.thread_id = ${threadId}`).pipe(Effect.orDie);

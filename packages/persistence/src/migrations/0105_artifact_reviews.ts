import {
  type AgentId,
  type ArtifactReview,
  type QuestId,
  type QuestState,
  questSummaryOf,
  type RegisteredArtifactId,
  type RegisteredArtifactKind,
  type TaskId,
  type TaskState,
} from "@hobbots/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Each artifact's review (ADR 037, #1422): waiting for you, then reviewed or dismissed, with when and
// by whom. Every artifact stored before is waiting.
//
// A Quest's ready-for-review count becomes the artifacts its completed Tasks made, of a kind you
// review, that still wait for you, found through the records that saw them. Each stored summary gets
// that count now, folded as the hub folds it, at the journal's head where it changed: no
// `QuestSummaryChanged` is journaled for it, as 0103 journaled none, and the revision of its next
// change is higher.

type Row = Record<string, unknown>;

export default Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  yield* sql`ALTER TABLE artifacts ADD COLUMN review TEXT NOT NULL DEFAULT 'waiting'
    CHECK (review IN ('waiting', 'reviewed', 'dismissed'))`;
  yield* sql`ALTER TABLE artifacts ADD COLUMN reviewed_at TEXT`;
  yield* sql`ALTER TABLE artifacts ADD COLUMN reviewed_by_kind TEXT`;
  yield* sql`ALTER TABLE artifacts ADD COLUMN reviewed_by_id TEXT`;
  // A Task's artifacts are found from the records that saw them.
  yield* sql`CREATE INDEX artifact_sightings_origin ON artifact_sightings (origin_kind, origin_id)`;

  const [head] = yield* sql<Row>`SELECT sequence FROM event_journal_head WHERE id = 1`;
  const revision = Number(head?.sequence ?? 0);
  const roots = yield* sql<Row>`SELECT DISTINCT t.root_id FROM quest_summaries s JOIN tasks t ON t.id = s.task_id`;
  for (const root of roots) {
    const rootId = String(root.root_id);
    const tasks = (yield* sql<Row>`SELECT id, parent_id, state FROM tasks WHERE root_id = ${rootId}`).map((row) => ({
      id: String(row.id) as TaskId,
      parentId: row.parent_id == null ? null : (String(row.parent_id) as TaskId),
      state: String(row.state) as TaskState,
    }));
    const inTree = sql`SELECT id FROM tasks WHERE root_id = ${rootId}`;
    const made = yield* sql<Row>`SELECT a.id AS artifact_id, r.task_id, a.kind, a.review FROM artifacts a
        JOIN artifact_sightings g ON g.artifact_id = a.id
        JOIN artifact_refs r ON g.origin_kind = 'task-artifact' AND r.id = g.origin_id
        WHERE r.task_id IN (${inTree})
      UNION ALL
      SELECT a.id AS artifact_id, x.task_id, a.kind, a.review FROM artifacts a
        JOIN artifact_sightings g ON g.artifact_id = a.id
        JOIN attempts x ON g.origin_kind = 'attempt' AND x.id = g.origin_id
        WHERE x.task_id IN (${inTree})`;
    const tree = {
      tasks,
      // Only the ready-for-review count changes, so nothing else is read.
      questions: [],
      approvals: [],
      delivered: made.map((row) => ({
        artifactId: String(row.artifact_id) as RegisteredArtifactId,
        taskId: String(row.task_id) as TaskId,
        kind: String(row.kind) as RegisteredArtifactKind,
        review: String(row.review) as ArtifactReview,
      })),
    };
    const summaries = yield* sql<Row>`SELECT * FROM quest_summaries WHERE task_id IN (${inTree})`;
    for (const stored of summaries) {
      const { readyForReview } = questSummaryOf(
        {
          id: String(stored.quest_id) as QuestId,
          taskId: String(stored.task_id) as TaskId,
          leadId: String(stored.lead_id) as AgentId,
          parentQuestId: null,
          threadId: null,
          state: String(stored.state) as QuestState,
        },
        tree,
      );
      if (readyForReview === Number(stored.ready_for_review)) continue;
      yield* sql`UPDATE quest_summaries SET ready_for_review = ${readyForReview}, revision = ${revision}
        WHERE quest_id = ${String(stored.quest_id)}`;
    }
  }
});

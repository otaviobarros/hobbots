import {
  type AgentId,
  Artifact,
  type ArtifactReview,
  baseName,
  canonicalPath,
  carriedReview,
  fileLocator,
  isAbsolutePath,
  type QuestId,
  type QuestState,
  questSummaryOf,
  type RegisteredArtifactId,
  type RegisteredArtifactKind,
  type TaskId,
  type TaskState,
} from "@hobbots/domain";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

// An artifact's versions (ADR 037, #1434). Each record that saw an artifact now says which version it
// made, which Attempt's work it is, and when the hub saw it. The records of one Attempt are one
// version: its file changes, and the file its Task returned from it.
//
// Every file is kept at one canonical place. A Task that returned `social.md` was kept as it said,
// while its Attempt's change was kept in its folder, so one file was two rows. Each file's place is
// now spelled one way, a relative one resolved against its Attempt's folder (where it changed a file
// at that path, else the first folder it scanned), and two rows of one camp at one place become one:
// the row that was there takes the other's records and keeps the newer fields, a review the other
// settled carried over, as a moved chapter's artifact joins the camp's. The find index follows, and
// each Quest that made one counts what it has ready for review again, folded as the hub folds it, at
// the journal's head: nothing is journaled for these, as 0105 journaled none.

type Row = Record<string, unknown>;
type Sql = SqlClient.SqlClient;

const text = (value: unknown) => String(value);
const nullable = (value: unknown) => (value == null ? null : String(value));

/** A stored artifact, read with the domain's own rules for its review. */
const artifactOf = (row: Row) =>
  Schema.decodeUnknownEffect(Artifact)({
    id: text(row.id),
    threadId: text(row.thread_id),
    chapterId: text(row.chapter_id),
    kind: text(row.kind),
    title: text(row.title),
    locator: text(row.locator),
    latestVersion: Number(row.latest_version),
    origin: { kind: text(row.origin_kind), id: text(row.origin_id) },
    actor: { kind: text(row.actor_kind), id: text(row.actor_id) },
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    review: text(row.review),
    reviewedAt: nullable(row.reviewed_at),
    reviewedBy:
      row.reviewed_by_kind == null || row.reviewed_by_id == null
        ? null
        : { kind: text(row.reviewed_by_kind), id: text(row.reviewed_by_id) },
    revision: Number(row.revision),
  }).pipe(Effect.orDie);

/** Whether a stored locator is a file's path: not a link, and not a text result's id. */
const isFile = (locator: string) => !locator.includes("://") && !locator.startsWith("text:");

/** Where a stored file is, canonical: a relative path resolved against its Attempt's folder. */
const placeOf = (sql: Sql, artifactId: string, locator: string) =>
  Effect.gen(function* () {
    const path = canonicalPath(locator);
    if (isAbsolutePath(path)) return path;
    const [attempt] = yield* sql<Row>`SELECT attempt_id FROM artifact_sightings
      WHERE artifact_id = ${artifactId} AND attempt_id IS NOT NULL ORDER BY seen_at`;
    if (attempt === undefined) return path;
    const attemptId = text(attempt.attempt_id);
    const [changed] = yield* sql<Row>`SELECT folder FROM attempt_file_changes
      WHERE attempt_id = ${attemptId} AND path = ${path} ORDER BY recorded_at, id`;
    const [scanned] = yield* sql<Row>`SELECT folder FROM attempt_folder_scans
      WHERE attempt_id = ${attemptId} ORDER BY started_at, id`;
    const folder = changed?.folder ?? scanned?.folder;
    return folder == null ? path : fileLocator(path, text(folder));
  });

/** `moved` joins `kept`, at the same place in the same camp; at the journal's head. */
const merge = (sql: Sql, revision: number, kept: Artifact, moved: Artifact) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO artifact_sightings (artifact_id, origin_kind, origin_id, attempt_id, version, seen_at)
      SELECT ${kept.id}, origin_kind, origin_id, attempt_id, version, seen_at FROM artifact_sightings s
      WHERE s.artifact_id = ${moved.id} AND NOT EXISTS (SELECT 1 FROM artifact_sightings e
        WHERE e.artifact_id = ${kept.id} AND e.origin_kind = s.origin_kind AND e.origin_id = s.origin_id)`;
    const newer = moved.updatedAt > kept.updatedAt ? moved : kept;
    // A name a record gave wins over a file's own name.
    const named = [newer, kept, moved].find((each) => each.title !== baseName(kept.locator)) ?? newer;
    const reviewed = carriedReview(kept, moved) ?? kept;
    yield* sql`UPDATE artifacts SET kind = ${newer.kind}, title = ${named.title}, origin_kind = ${newer.origin.kind},
      origin_id = ${newer.origin.id}, actor_kind = ${newer.actor.kind}, actor_id = ${newer.actor.id},
      created_at = ${[kept.createdAt, moved.createdAt].toSorted()[0] ?? kept.createdAt},
      updated_at = ${newer.updatedAt}, review = ${reviewed.review}, reviewed_at = ${reviewed.reviewedAt},
      reviewed_by_kind = ${reviewed.reviewedBy?.kind ?? null}, reviewed_by_id = ${reviewed.reviewedBy?.id ?? null},
      revision = ${revision} WHERE id = ${kept.id}`;
    yield* sql`DELETE FROM artifact_sightings WHERE artifact_id = ${moved.id}`;
    yield* sql`DELETE FROM find_records WHERE kind = 'artifact' AND record_id = ${moved.id}`;
    yield* sql`DELETE FROM artifacts WHERE id = ${moved.id}`;
  });

/** Moves each file to its one place, merging two rows of a camp there; returns the rows that took another. */
const canonicalize = (sql: Sql, revision: number) =>
  Effect.gen(function* () {
    const merged = new Set<string>();
    for (const row of yield* sql<Row>`SELECT * FROM artifacts ORDER BY created_at, id`) {
      const artifact = yield* artifactOf(row);
      if (!isFile(artifact.locator)) continue;
      const place = yield* placeOf(sql, artifact.id, artifact.locator);
      if (place === artifact.locator) continue;
      const [other] = yield* sql<Row>`SELECT * FROM artifacts WHERE thread_id = ${artifact.threadId}
      AND locator = ${place} AND id <> ${artifact.id}`;
      if (other === undefined) {
        yield* sql`UPDATE artifacts SET locator = ${place}, revision = ${revision} WHERE id = ${artifact.id}`;
        continue;
      }
      yield* merge(sql, revision, yield* artifactOf(other), artifact);
      merged.add(text(other.id));
    }
    return merged;
  });

/** Numbers each record's version: the records of one Attempt are one, the rest one each, in the order seen. */
const numberVersions = (sql: Sql, revision: number, merged: ReadonlySet<string>) =>
  Effect.gen(function* () {
    for (const row of yield* sql<Row>`SELECT id FROM artifacts`) {
      const artifactId = text(row.id);
      const sightings = yield* sql<Row>`SELECT origin_kind, origin_id, attempt_id FROM artifact_sightings
      WHERE artifact_id = ${artifactId} ORDER BY seen_at, origin_kind, origin_id`;
      const byAttempt = new Map<string, number>();
      let latest = 0;
      for (const sighting of sightings) {
        const attemptId = nullable(sighting.attempt_id);
        const counted = attemptId === null ? undefined : byAttempt.get(attemptId);
        const version = counted ?? ++latest;
        if (attemptId !== null) byAttempt.set(attemptId, version);
        yield* sql`UPDATE artifact_sightings SET version = ${version} WHERE artifact_id = ${artifactId}
        AND origin_kind = ${text(sighting.origin_kind)} AND origin_id = ${text(sighting.origin_id)}`;
      }
      if (latest === 0) continue;
      const [stored] = yield* sql<Row>`SELECT latest_version FROM artifacts WHERE id = ${artifactId}`;
      if (Number(stored?.latest_version) === latest && !merged.has(artifactId)) continue;
      yield* sql`UPDATE artifacts SET latest_version = ${latest}, revision = ${revision} WHERE id = ${artifactId}`;
    }
  });

/** Counts again what each Quest that made a merged artifact has ready for review. */
const recountQuests = (sql: Sql, revision: number, merged: ReadonlySet<string>) =>
  Effect.gen(function* () {
    if (merged.size === 0) return;
    const roots = yield* sql<Row>`SELECT DISTINCT t.root_id FROM tasks t
    WHERE t.id IN (SELECT r.task_id FROM artifact_sightings g JOIN artifact_refs r
        ON g.origin_kind = 'task-artifact' AND r.id = g.origin_id WHERE ${sql.in("g.artifact_id", [...merged])})
      OR t.id IN (SELECT x.task_id FROM artifact_sightings g JOIN attempts x
        ON g.origin_kind = 'attempt' AND x.id = g.origin_id WHERE ${sql.in("g.artifact_id", [...merged])})`;
    for (const root of roots) {
      const rootId = text(root.root_id);
      const tasks = (yield* sql<Row>`SELECT id, parent_id, state FROM tasks WHERE root_id = ${rootId}`).map((row) => ({
        id: text(row.id) as TaskId,
        parentId: row.parent_id == null ? null : (text(row.parent_id) as TaskId),
        state: text(row.state) as TaskState,
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
      const delivered = made.map((row) => ({
        artifactId: text(row.artifact_id) as RegisteredArtifactId,
        taskId: text(row.task_id) as TaskId,
        kind: text(row.kind) as RegisteredArtifactKind,
        review: text(row.review) as ArtifactReview,
      }));
      for (const stored of yield* sql<Row>`SELECT * FROM quest_summaries WHERE task_id IN (${inTree})`) {
        const { readyForReview } = questSummaryOf(
          {
            id: text(stored.quest_id) as QuestId,
            taskId: text(stored.task_id) as TaskId,
            leadId: text(stored.lead_id) as AgentId,
            parentQuestId: null,
            threadId: null,
            state: text(stored.state) as QuestState,
          },
          // Only the ready-for-review count changes, so nothing else is read.
          { tasks, questions: [], approvals: [], delivered },
        );
        if (readyForReview === Number(stored.ready_for_review)) continue;
        yield* sql`UPDATE quest_summaries SET ready_for_review = ${readyForReview}, revision = ${revision}
        WHERE quest_id = ${text(stored.quest_id)}`;
      }
    }
  });

export default Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  yield* sql`ALTER TABLE artifact_sightings ADD COLUMN attempt_id TEXT`;
  yield* sql`ALTER TABLE artifact_sightings ADD COLUMN version INTEGER`;
  yield* sql`ALTER TABLE artifact_sightings ADD COLUMN seen_at TEXT`;
  yield* sql`UPDATE artifact_sightings SET attempt_id = origin_id WHERE origin_kind = 'attempt'`;
  yield* sql`UPDATE artifact_sightings SET attempt_id = (SELECT r.attempt_id FROM artifact_refs r
    WHERE r.id = artifact_sightings.origin_id) WHERE origin_kind = 'task-artifact'`;
  // When the record was made: the Attempt's first change, the Task's result, or the reply.
  yield* sql`UPDATE artifact_sightings SET seen_at = COALESCE(
      CASE origin_kind
        WHEN 'attempt' THEN (SELECT MIN(c.recorded_at) FROM attempt_file_changes c WHERE c.attempt_id = origin_id)
        WHEN 'task-artifact' THEN (SELECT r.created_at FROM artifact_refs r WHERE r.id = origin_id)
        WHEN 'message' THEN (SELECT m.created_at FROM messages m WHERE m.id = origin_id)
      END,
      (SELECT a.created_at FROM artifacts a WHERE a.id = artifact_sightings.artifact_id))`;
  yield* sql`CREATE INDEX artifact_sightings_attempt ON artifact_sightings (artifact_id, attempt_id)`;

  const [head] = yield* sql<Row>`SELECT sequence FROM event_journal_head WHERE id = 1`;
  const revision = Number(head?.sequence ?? 0);

  const merged = yield* canonicalize(sql, revision);
  yield* numberVersions(sql, revision, merged);
  // The find index says where each merged or moved artifact is now.
  yield* sql`UPDATE find_records SET
      title = (SELECT a.title FROM artifacts a WHERE a.id = find_records.record_id),
      detail = (SELECT a.locator FROM artifacts a WHERE a.id = find_records.record_id),
      body = (SELECT a.title || ' ' || a.locator FROM artifacts a WHERE a.id = find_records.record_id),
      version = (SELECT a.latest_version FROM artifacts a WHERE a.id = find_records.record_id)
    WHERE kind = 'artifact' AND record_id IN (SELECT id FROM artifacts WHERE revision = ${revision})`;

  yield* recountQuests(sql, revision, merged);
});

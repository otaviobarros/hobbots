import {
  AgentId,
  Artifact,
  type ArtifactOrigin,
  ArtifactReview,
  type ArtifactSighting,
  AttemptId,
  artifactSightings,
  ChapterId,
  ContentId,
  type DeliveredArtifact,
  fileLocator,
  isFileLocator,
  isTextLocator,
  type JournaledEvent,
  type PlacedSighting,
  placedFromTask,
  RegisteredArtifactId,
  RegisteredArtifactKind,
  registeredArtifact,
  resolvedSighting,
  type StoredVersion,
  type StoredVersionSource,
  TaskId,
  ThreadId,
} from "@hobbots/domain";
import { DateTime, Effect, Schema } from "effect";
import type { SqlClient, SqlError, Statement } from "effect/sql";

// The artifacts registry (ADR 037, migration 0101): one row per thing a hob made or changed in a
// chat or camp, filled in the transaction that journals the records it indexes, as backpack items
// are. It copies nothing: a row holds where the thing is and which record saw its latest version.

/** A row of `artifacts`, as the SQL client reads it. */
export interface ArtifactRow {
  readonly id: string;
  readonly threadId: string;
  readonly chapterId: string;
  readonly kind: string;
  readonly title: string;
  readonly locator: string;
  readonly latestVersion: number | string;
  readonly originKind: string;
  readonly originId: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly review: string;
  readonly reviewedAt: string | null;
  readonly reviewedByKind: string | null;
  readonly reviewedById: string | null;
  readonly revision: number | string;
}

const decode = Schema.decodeUnknownEffect(Artifact);

/** A stored artifact; a row that does not decode is a defect, since the hub wrote it. */
export const artifactFromRow = (row: ArtifactRow) =>
  decode({
    id: row.id,
    threadId: row.threadId,
    chapterId: row.chapterId,
    kind: row.kind,
    title: row.title,
    locator: row.locator,
    latestVersion: Number(row.latestVersion),
    origin: { kind: row.originKind, id: row.originId },
    actor: { kind: row.actorKind, id: row.actorId },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    review: row.review,
    reviewedAt: row.reviewedAt,
    reviewedBy:
      row.reviewedByKind === null || row.reviewedById === null
        ? null
        : { kind: row.reviewedByKind, id: row.reviewedById },
    // PostgreSQL reads BIGINT as a bigint; every revision fits a number.
    revision: Number(row.revision),
  }).pipe(Effect.orDie);

export const artifactsFromRows = (rows: ReadonlyArray<ArtifactRow>) => Effect.forEach(rows, artifactFromRow);

const artifactColumns = (artifact: Artifact) => ({
  id: artifact.id,
  thread_id: artifact.threadId,
  chapter_id: artifact.chapterId,
  kind: artifact.kind,
  title: artifact.title,
  locator: artifact.locator,
  latest_version: artifact.latestVersion,
  origin_kind: artifact.origin.kind,
  origin_id: artifact.origin.id,
  actor_kind: artifact.actor.kind,
  actor_id: artifact.actor.id,
  created_at: artifact.createdAt,
  updated_at: artifact.updatedAt,
  review: artifact.review,
  reviewed_at: artifact.reviewedAt,
  reviewed_by_kind: artifact.reviewedBy?.kind ?? null,
  reviewed_by_id: artifact.reviewedBy?.id ?? null,
  revision: artifact.revision,
});

/** Writes an artifact's review as it now stands, at the revision of the event that journals it. */
export const saveReview = (sql: SqlClient.SqlClient, artifact: Artifact) => {
  const columns = artifactColumns(artifact);
  return sql`UPDATE artifacts SET review = ${columns.review}, reviewed_at = ${columns.reviewed_at},
    reviewed_by_kind = ${columns.reviewed_by_kind}, reviewed_by_id = ${columns.reviewed_by_id},
    revision = ${columns.revision} WHERE id = ${artifact.id}`;
};

/**
 * The Tasks that made registered artifacts, by the records that saw them: a result a Task returned,
 * or its Attempt's file changes. A reply's own files were made by no Task. `where` picks the pairs,
 * by `a.id` (the artifact) or `t.task_id` (the Task); a pair can come back more than once.
 */
const madeBy = (sql: SqlClient.SqlClient, where: (column: string) => Statement.Fragment) =>
  sql<{ readonly artifactId: string; readonly taskId: string; readonly kind: string; readonly review: string }>`
    SELECT a.id AS artifact_id, t.task_id, a.kind, a.review FROM artifacts a
      JOIN artifact_sightings s ON s.artifact_id = a.id
      JOIN artifact_refs t ON s.origin_kind = 'task-artifact' AND t.id = s.origin_id
      WHERE ${where("t.task_id")}
    UNION ALL
    SELECT a.id AS artifact_id, t.task_id, a.kind, a.review FROM artifacts a
      JOIN artifact_sightings s ON s.artifact_id = a.id
      JOIN attempts t ON s.origin_kind = 'attempt' AND t.id = s.origin_id
      WHERE ${where("t.task_id")}`;

const DeliveredRows = Schema.Array(
  Schema.Struct({
    artifactId: RegisteredArtifactId,
    taskId: TaskId,
    kind: RegisteredArtifactKind,
    review: ArtifactReview,
  }),
);

/** What the Tasks made that the registry holds, with each artifact's kind and review: what a Quest summary counts. */
export const deliveredBy = (
  sql: SqlClient.SqlClient,
  taskIds: ReadonlyArray<TaskId>,
): Effect.Effect<ReadonlyArray<DeliveredArtifact>, SqlError.SqlError> =>
  taskIds.length === 0
    ? Effect.succeed([])
    : madeBy(sql, (column) => sql.in(column, taskIds)).pipe(
        // Rows the hub wrote: one that does not decode is a defect.
        Effect.flatMap((rows) => Schema.decodeUnknownEffect(DeliveredRows)(rows).pipe(Effect.orDie)),
      );

/** The Tasks that made the artifacts, each once. */
export const tasksThatMade = (sql: SqlClient.SqlClient, artifactIds: ReadonlyArray<string>) =>
  artifactIds.length === 0
    ? Effect.succeed<ReadonlyArray<string>>([])
    : madeBy(sql, () => sql.in("a.id", artifactIds)).pipe(
        Effect.map((rows) => [...new Set(rows.map((row) => row.taskId))]),
      );

/**
 * The folder an Attempt worked in, for a path relative to it (#1434): the one where it changed a file
 * at that path, else the first it scanned, as a turn's paths resolve against the hob's first folder.
 * Null when it neither changed nor scanned any.
 */
const attemptFolder = (sql: SqlClient.SqlClient, attemptId: string, path: string) =>
  Effect.gen(function* () {
    const [changed] = yield* sql<{ readonly folder: string }>`SELECT folder FROM attempt_file_changes
      WHERE attempt_id = ${attemptId} AND path = ${path} ORDER BY recorded_at, id`;
    if (changed !== undefined) return changed.folder;
    const [scanned] = yield* sql<{ readonly folder: string }>`SELECT folder FROM attempt_folder_scans
      WHERE attempt_id = ${attemptId} ORDER BY started_at, id`;
    return scanned?.folder ?? null;
  });

/** A sighting with its relative path resolved against its Attempt's folder, when one is known. */
const resolved = (sql: SqlClient.SqlClient, sighting: ArtifactSighting) =>
  sighting.relativeTo === null
    ? Effect.succeed(sighting)
    : Effect.map(attemptFolder(sql, sighting.relativeTo, sighting.locator), (folder) =>
        folder === null ? sighting : resolvedSighting(sighting, folder),
      );

/**
 * Where a sighting lands: a reply's own thread, chapter and author, or a Task's thread, that
 * thread's live chapter and the Task's owner. Null for a Task outside any chat or camp.
 */
const placeOf = (sql: SqlClient.SqlClient, unresolved: ArtifactSighting) =>
  Effect.gen(function* () {
    const sighting = yield* resolved(sql, unresolved);
    const { from } = sighting;
    if (from._tag === "Message") {
      return { sighting, threadId: from.threadId, chapterId: from.chapterId, actor: from.actor } as PlacedSighting;
    }
    const [task] = yield* sql<{
      readonly threadId: string | null;
      readonly ownerId: string;
      readonly chapterId: string | null;
    }>`SELECT t.thread_id, t.owner_id,
        (SELECT c.id FROM chapters c WHERE c.thread_id = t.thread_id AND c.state = 'live') AS chapter_id
      FROM tasks t WHERE t.id = ${from.taskId}`;
    if (task?.threadId == null || task.chapterId == null) return null;
    return placedFromTask(sighting, {
      threadId: ThreadId.make(task.threadId),
      chapterId: ChapterId.make(task.chapterId),
      ownerId: AgentId.make(task.ownerId),
    });
  });

/**
 * The version a record of `attemptId` counted, when one saw the artifact before: its work is that
 * version. Null when none did.
 */
const attemptVersion = (sql: SqlClient.SqlClient, artifactId: string, attemptId: string | null) =>
  attemptId === null
    ? Effect.succeed(null)
    : Effect.map(
        sql<{ readonly version: number | string }>`SELECT version FROM artifact_sightings
          WHERE artifact_id = ${artifactId} AND attempt_id = ${attemptId} ORDER BY version`,
        ([row]) => (row === undefined ? null : Number(row.version)),
      );

/**
 * Registers one placed sighting at `revision`; the artifact it wrote, or null when it changed
 * nothing. A record not seen before is kept with the version it made, even when that is the version
 * another record of its Attempt counted, so the Task it came from is still found by it.
 */
const register = (sql: SqlClient.SqlClient, placed: PlacedSighting, revision: number, at: string) =>
  Effect.gen(function* () {
    const { sighting } = placed;
    const [row] = yield* sql<ArtifactRow>`SELECT * FROM artifacts
      WHERE thread_id = ${placed.threadId} AND locator = ${sighting.locator}`;
    const existing = row === undefined ? null : yield* artifactFromRow(row);
    const seen =
      existing !== null &&
      (yield* sql`SELECT 1 FROM artifact_sightings WHERE artifact_id = ${existing.id}
        AND origin_kind = ${sighting.origin.kind} AND origin_id = ${sighting.origin.id}`).length > 0;
    if (seen) return null;
    const counted = existing === null ? null : yield* attemptVersion(sql, existing.id, sighting.attemptId);
    const sameAttempt = counted !== null;
    const next = registeredArtifact({
      existing,
      placed,
      seen,
      sameAttempt,
      id: RegisteredArtifactId.make(crypto.randomUUID()),
      at,
    });
    const artifact = next === null ? null : new Artifact({ ...next, revision });
    if (artifact !== null) {
      const columns = artifactColumns(artifact);
      if (existing === null) yield* sql`INSERT INTO artifacts ${sql.insert(columns)}`;
      else {
        yield* sql`UPDATE artifacts SET kind = ${columns.kind}, title = ${columns.title},
          latest_version = ${columns.latest_version}, origin_kind = ${columns.origin_kind},
          origin_id = ${columns.origin_id}, actor_kind = ${columns.actor_kind}, actor_id = ${columns.actor_id},
          updated_at = ${columns.updated_at}, revision = ${columns.revision} WHERE id = ${artifact.id}`;
      }
    }
    const kept = artifact ?? existing;
    if (kept === null) return null;
    yield* sql`INSERT INTO artifact_sightings ${sql.insert({
      artifact_id: kept.id,
      origin_kind: sighting.origin.kind,
      origin_id: sighting.origin.id,
      attempt_id: sighting.attemptId,
      version: counted ?? kept.latestVersion,
      seen_at: at,
    })}`;
    return artifact;
  });

/** A record's place among an artifact's versions, as `artifact_sightings` keeps it. */
interface SightingRow {
  readonly originKind: ArtifactOrigin["kind"];
  readonly originId: string;
  readonly attemptId: string | null;
  readonly version: number | string;
  readonly seenAt: string;
}

/** Which record of one version speaks for it: an Attempt's own changes first, then a Task's result. */
const SPEAKS_FIRST: ReadonlyArray<ArtifactOrigin["kind"]> = ["attempt", "task-artifact", "message"];

/**
 * Where one version's contents are: what its Attempt kept of the file, by its change at the
 * artifact's place, while not cleared; a text a Task returned; or nothing.
 */
const sourceOf = (sql: SqlClient.SqlClient, artifact: Artifact, records: ReadonlyArray<SightingRow>) =>
  Effect.gen(function* () {
    const none: StoredVersionSource = { _tag: "none" };
    if (isTextLocator(artifact.locator)) {
      const [ref] = yield* sql<{ readonly value: string }>`SELECT value FROM artifact_refs
        WHERE id = ${artifact.locator.slice("text:".length)}`;
      return ref === undefined ? none : ({ _tag: "text", text: ref.value } as const);
    }
    const attemptId = records.find((record) => record.attemptId !== null)?.attemptId ?? null;
    if (!isFileLocator(artifact.locator) || attemptId === null) return none;
    const changes = yield* sql<{
      readonly folder: string;
      readonly path: string;
      readonly afterContentId: string | null;
      readonly detailsClearedAt: string | null;
    }>`SELECT folder, path, after_content_id, details_cleared_at FROM attempt_file_changes
      WHERE attempt_id = ${attemptId}`;
    const kept = changes.find(
      (change) =>
        fileLocator(change.path, change.folder) === artifact.locator &&
        change.afterContentId !== null &&
        change.detailsClearedAt === null,
    );
    return kept?.afterContentId == null
      ? none
      : ({
          _tag: "kept",
          attemptId: AttemptId.make(attemptId),
          contentId: ContentId.make(kept.afterContentId),
        } as const);
  });

/** An artifact's versions as the registry keeps them, oldest first, each with where its contents are. */
export const storedVersions = (
  sql: SqlClient.SqlClient,
  artifact: Artifact,
): Effect.Effect<ReadonlyArray<StoredVersion>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql<SightingRow>`SELECT origin_kind, origin_id, attempt_id, version, seen_at
      FROM artifact_sightings WHERE artifact_id = ${artifact.id} ORDER BY version, seen_at`;
    const byVersion = new Map<number, Array<SightingRow>>();
    for (const row of rows) {
      const version = Number(row.version);
      byVersion.set(version, [...(byVersion.get(version) ?? []), row]);
    }
    return yield* Effect.forEach([...byVersion], ([version, records]) =>
      Effect.gen(function* () {
        const speaks = records.toSorted(
          (a, b) => SPEAKS_FIRST.indexOf(a.originKind) - SPEAKS_FIRST.indexOf(b.originKind),
        )[0] as SightingRow;
        const at = records.map((record) => record.seenAt).toSorted()[0] ?? artifact.createdAt;
        return {
          version,
          at,
          origin: { kind: speaks.originKind, id: speaks.originId },
          source: yield* sourceOf(sql, artifact, records),
        };
      }),
    );
  });

/**
 * Numbers an artifact's versions again after records joined it from another row, as a moved
 * chapter's artifact joins the camp's (#1434): in the order the hub saw them, the records of one
 * Attempt one version. Its latest version follows. Only for use within `sql.withTransaction`.
 */
export const renumberVersions = (sql: SqlClient.SqlClient, artifactId: string) =>
  Effect.gen(function* () {
    const sightings = yield* sql<{
      readonly originKind: string;
      readonly originId: string;
      readonly attemptId: string | null;
    }>`SELECT origin_kind, origin_id, attempt_id FROM artifact_sightings WHERE artifact_id = ${artifactId}
      ORDER BY seen_at, version, origin_kind, origin_id`;
    const byAttempt = new Map<string, number>();
    let latest = 0;
    for (const sighting of sightings) {
      const counted = sighting.attemptId === null ? undefined : byAttempt.get(sighting.attemptId);
      const version = counted ?? ++latest;
      if (sighting.attemptId !== null) byAttempt.set(sighting.attemptId, version);
      yield* sql`UPDATE artifact_sightings SET version = ${version} WHERE artifact_id = ${artifactId}
        AND origin_kind = ${sighting.originKind} AND origin_id = ${sighting.originId}`;
    }
    if (latest > 0) yield* sql`UPDATE artifacts SET latest_version = ${latest} WHERE id = ${artifactId}`;
  });

/**
 * Registers what the events say was made or changed, at journal sequences from `first` on, and
 * returns their `ArtifactRegistered` events: one per artifact a record made or moved to its next
 * version. A record that saw an artifact before changes nothing, so the same events again register
 * nothing. Only for use within `sql.withTransaction`, after the change wrote.
 */
export const registerArtifacts = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const sightings = artifactSightings(events);
    if (sightings.length === 0) return [];
    const at = DateTime.formatIso(yield* DateTime.now);
    const registered: Array<JournaledEvent> = [];
    for (const sighting of sightings) {
      const placed = yield* placeOf(sql, sighting);
      if (placed === null) continue;
      const artifact = yield* register(sql, placed, first + registered.length, at);
      if (artifact !== null) registered.push({ _tag: "ArtifactRegistered", artifact });
    }
    return registered;
  });

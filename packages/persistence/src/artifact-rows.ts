import {
  AgentId,
  Artifact,
  type ArtifactSighting,
  artifactSightings,
  ChapterId,
  type JournaledEvent,
  type PlacedSighting,
  placedFromTask,
  RegisteredArtifactId,
  registeredArtifact,
  ThreadId,
} from "@hobbots/domain";
import { DateTime, Effect, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

// The artifacts registry (ADR 037, migration 0100): one row per thing a hob made or changed in a
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
  readonly revision: number | string;
}

const decode = Schema.decodeUnknownEffect(Artifact);

/** A stored artifact; a row that does not decode is a defect, since the hub wrote it. */
const artifactFromRow = (row: ArtifactRow) =>
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
  revision: artifact.revision,
});

/**
 * Where a sighting lands: a reply's own thread, chapter and author, or a Task's thread, that
 * thread's live chapter and the Task's owner. Null for a Task outside any chat or camp.
 */
const placeOf = (sql: SqlClient.SqlClient, sighting: ArtifactSighting) =>
  Effect.gen(function* () {
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

/** Registers one placed sighting at `revision`; the artifact it wrote, or null when it changed nothing. */
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
    const next = registeredArtifact({
      existing,
      placed,
      seen,
      id: RegisteredArtifactId.make(crypto.randomUUID()),
      at,
    });
    if (next === null) return null;
    const artifact = new Artifact({ ...next, revision });
    const columns = artifactColumns(artifact);
    if (existing === null) yield* sql`INSERT INTO artifacts ${sql.insert(columns)}`;
    else {
      yield* sql`UPDATE artifacts SET kind = ${columns.kind}, title = ${columns.title},
        latest_version = ${columns.latest_version}, origin_kind = ${columns.origin_kind},
        origin_id = ${columns.origin_id}, actor_kind = ${columns.actor_kind}, actor_id = ${columns.actor_id},
        updated_at = ${columns.updated_at}, revision = ${columns.revision} WHERE id = ${artifact.id}`;
    }
    yield* sql`INSERT INTO artifact_sightings ${sql.insert({
      artifact_id: artifact.id,
      origin_kind: sighting.origin.kind,
      origin_id: sighting.origin.id,
    })}`;
    return artifact;
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

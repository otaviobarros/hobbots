import { Claim, type ClaimEvent, Claims, isTerminalTask, type JournaledEvent, type TaskId } from "@hobbots/domain";
import { DateTime, Effect, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

/** A row of `claims` (migration 0098), as the SQL client reads it. */
export interface ClaimRow {
  readonly id: string;
  readonly scope: string;
  readonly repository: string;
  readonly directory: string | null;
  readonly claimKey: string;
  readonly taskId: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly releasedAt: string | null;
  readonly revision: number | string;
}

const decode = Schema.decodeUnknownEffect(Claim);

/** A stored claim; a row that does not decode is a defect, since the hub wrote it. */
const claimFromRow = (row: ClaimRow) =>
  decode({
    id: row.id,
    scope: row.scope,
    repository: row.repository,
    directory: row.directory,
    key: row.claimKey,
    taskId: row.taskId,
    actor: { kind: row.actorKind, id: row.actorId },
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    releasedAt: row.releasedAt,
    // PostgreSQL reads BIGINT as a bigint; every revision fits a number.
    revision: Number(row.revision),
  }).pipe(Effect.orDie);

export const claimsFromRows = (rows: ReadonlyArray<ClaimRow>) => Effect.forEach(rows, claimFromRow);

export const claimToRow = (claim: Claim) => ({
  id: claim.id,
  scope: claim.scope,
  repository: claim.repository,
  directory: claim.directory,
  claim_key: claim.key,
  task_id: claim.taskId,
  actor_kind: claim.actor.kind,
  actor_id: claim.actor.id,
  state: claim.state,
  created_at: claim.createdAt,
  updated_at: claim.updatedAt,
  released_at: claim.releasedAt,
  revision: claim.revision,
});

/**
 * `claim` after `event`, at `revision`. Its state allows the event, which the caller read in the same
 * transaction: a refusal is a defect.
 */
export const movedClaim = (claim: Claim, event: ClaimEvent, revision: number): Claim => {
  const next = Claims.transition(claim, event);
  if (!(next instanceof Claim)) throw new Error(`Claim ${claim.id} is ${claim.state} and cannot take ${event._tag}`);
  return new Claim({ ...next, revision });
};

/** Writes a claim's new state over its row. */
export const saveClaim = (sql: SqlClient.SqlClient, claim: Claim) =>
  sql`UPDATE claims SET state = ${claim.state}, updated_at = ${claim.updatedAt}, released_at = ${claim.releasedAt},
    revision = ${claim.revision} WHERE id = ${claim.id}`;

/** The Tasks the events end, at any depth: their claims are released with them (ADR 037). */
const endedTasks = (events: ReadonlyArray<JournaledEvent>): ReadonlyArray<TaskId> => [
  ...new Set(
    events.flatMap((event) =>
      (event._tag === "TaskStateChanged" || event._tag === "TaskCompleted") && isTerminalTask(event.task.state)
        ? [event.task.id]
        : [],
    ),
  ),
];

/**
 * Releases the open claims of the Tasks the events end, at journal sequences from `first` on, and
 * moves each contested claim that clashes with nothing left back to held. Returns their
 * ClaimReleased and ClaimCleared events. A retry that reopens a failed Task does not bring them
 * back: a released number is never handed out again. Only for use within `sql.withTransaction`,
 * after the change wrote.
 */
export const releaseEndedClaims = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const ended = endedTasks(events);
    if (ended.length === 0) return [];
    const held = yield* claimsFromRows(
      yield* sql<ClaimRow>`SELECT * FROM claims WHERE ${sql.in("task_id", ended)} AND state <> 'released'
        ORDER BY created_at, id`,
    );
    if (held.length === 0) return [];
    const at = DateTime.formatIso(yield* DateTime.now);
    const released = held.map((claim, index) => movedClaim(claim, { _tag: "Release", at }, first + index));
    const repositories = [...new Set(released.map((claim) => claim.repository))];
    const open = yield* claimsFromRows(
      yield* sql<ClaimRow>`SELECT * FROM claims WHERE state <> 'released' AND ${sql.in("repository", repositories)}
        ORDER BY created_at, id`,
    );
    const cleared = Claims.clearedBy(released, open).map((claim, index) =>
      movedClaim(claim, { _tag: "Clear", at }, first + released.length + index),
    );
    for (const claim of [...released, ...cleared]) yield* saveClaim(sql, claim);
    return [
      ...released.map((claim) => ({ _tag: "ClaimReleased" as const, claim })),
      ...cleared.map((claim) => ({ _tag: "ClaimCleared" as const, claim })),
    ];
  });

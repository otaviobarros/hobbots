import { Grant, isTerminalTask, type JournaledEvent, type TaskId } from "@hobbots/domain";
import { DateTime, Effect, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

interface GrantRowShape {
  readonly rule?: unknown;
  readonly revision?: unknown;
}

// The rule is JSON text and the revision a bigint on PostgreSQL (migration 0022).
export const grantRows = (rows: ReadonlyArray<GrantRowShape>) =>
  rows.map((row) => ({ ...row, rule: JSON.parse(String(row.rule)), revision: Number(row.revision) }));

const decodeGrants = Schema.decodeUnknownEffect(Schema.Array(Grant));

/** The top Tasks the events end: a This Task grant ends with its top Task (ADR 018). */
const endedTops = (events: ReadonlyArray<JournaledEvent>): ReadonlyArray<TaskId> => [
  ...new Set(
    events.flatMap((event) =>
      (event._tag === "TaskStateChanged" || event._tag === "TaskCompleted") &&
      event.task.parentId === null &&
      isTerminalTask(event.task.state)
        ? [event.task.id]
        : [],
    ),
  ),
];

/**
 * Revokes the live grants bound to the top Tasks the events end, at journal sequences from `first`
 * on, and returns their GrantRevoked events. A retry that reopens a failed top Task does not bring
 * them back: the next call asks again. Only for use within `sql.withTransaction`, after the change wrote.
 */
export const endTaskGrants = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const tops = endedTops(events);
    if (tops.length === 0) return [];
    const rows = yield* sql`SELECT * FROM grants WHERE ${sql.in("task_id", tops)} AND revoked_at IS NULL
      ORDER BY created_at, id`;
    const live = yield* decodeGrants(grantRows(rows)).pipe(Effect.orDie);
    const at = DateTime.formatIso(yield* DateTime.now);
    return yield* Effect.forEach(live, (grant, index) =>
      Effect.gen(function* () {
        const revision = first + index;
        const ended = new Grant({ ...grant, revokedAt: at, revokedBy: "hub", revokeReason: "task-ended", revision });
        yield* sql`UPDATE grants SET revoked_at = ${at}, revoked_by = 'hub', revoke_reason = 'task-ended',
          revision = ${revision} WHERE id = ${grant.id}`;
        return { _tag: "GrantRevoked", grant: ended } as const;
      }),
    );
  });

import { SupervisionRecords } from "@hobbots/agents";
import { Supervision, type TaskId } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";

interface Row {
  readonly taskId: string;
  readonly rootId: string;
  readonly state: string;
  readonly retries: unknown;
  readonly refusalsSeen: unknown;
  readonly attemptId: string | null;
  readonly rule: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
}

const decode = Schema.decodeUnknownEffect(Supervision);

/**
 * The supervisor's records (#1447), on SQLite and PostgreSQL (migration
 * `20261114162646_task_supervision`), each change journaled as `TaskSupervised` in the same
 * transaction. A row this Hobbots cannot read is skipped, so the supervisor looks at that Task afresh.
 */
export const SupervisionRecordsLive = Layer.effect(
  SupervisionRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const listIn = (rootId: TaskId) =>
      Effect.gen(function* () {
        const rows = yield* sql<Row>`SELECT task_id, root_id, state, retries, refusals_seen, attempt_id, rule, reason,
          updated_at FROM task_supervision WHERE root_id = ${rootId} ORDER BY task_id`;
        const read = yield* Effect.forEach(rows, (row) =>
          decode({ ...row, retries: Number(row.retries), refusalsSeen: Number(row.refusalsSeen) }).pipe(
            Effect.map((record) => [record]),
            Effect.catchTag("SchemaError", () => Effect.succeed([])),
          ),
        );
        return read.flat();
      }).pipe(Effect.orDie);
    const journaled = makeJournaledChange(sql);
    const save = (record: Supervision) =>
      journaled(() =>
        Effect.gen(function* () {
          const columns = {
            root_id: record.rootId,
            state: record.state,
            retries: record.retries,
            refusals_seen: record.refusalsSeen,
            attempt_id: record.attemptId,
            rule: record.rule,
            reason: record.reason,
            updated_at: record.updatedAt,
          };
          yield* sql`INSERT INTO task_supervision ${sql.insert({ task_id: record.taskId, ...columns })}
            ON CONFLICT (task_id) DO UPDATE SET ${sql.update(columns)}`;
          return { value: record, events: [{ _tag: "TaskSupervised" as const, supervision: record }] };
        }),
      );
    return SupervisionRecords.of({ listIn, save });
  }),
);

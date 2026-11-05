import { MemorySaves } from "@hobbots/agents";
import { MemorySave } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaled } from "./journal.ts";
import { beginMemoryCall, type MemoryCallRow, memoryCallColumns, memoryCallFields } from "./memory-calls.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface Row extends MemoryCallRow {
  readonly undoneAt: string | null;
}

const decodeSave = Schema.decodeUnknownEffect(MemorySave);

const fromRow = (row: Row) =>
  decodeSave({
    ...memoryCallFields(row),
    ...(row.undoneAt === null ? {} : { undoneAt: row.undoneAt }),
  }).pipe(Effect.orDie);

const toRow = (save: MemorySave) => ({ ...memoryCallColumns(save), undone_at: save.undoneAt ?? null });

/**
 * The SQL record of memory saves (migrations 0055 and 0058), keyed by hob, work and key. A save is recorded
 * and journaled in one transaction (ADR 028: the journal is the outbox), with the journal's head
 * taken first, so two calls with one key take turns on PostgreSQL and only the first is recorded.
 */
export const MemorySavesLive = Layer.effect(
  MemorySaves,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);

    return MemorySaves.of({
      begin: (save, also) =>
        Effect.map(
          beginMemoryCall<Row, MemorySave>(
            sql,
            "memory_saves",
            save,
            also,
            { columns: toRow(save), recorded: { _tag: "MemorySaveRecorded", save } },
            fromRow,
          ),
          (started) => (started._tag === "Existing" ? { _tag: "Existing", save: started.call } : started),
        ),
      // One conditional update, so of two outcomes racing for the same save only the first lands. By its
      // id, not its work, so a save still settles after its reply's calls moved to the Task it started.
      settle: (save, state, version, at) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const [row] = yield* sql<Row>`
              UPDATE memory_saves SET state = ${state}, version = ${version}, updated_at = ${at}
              WHERE id = ${save.id} AND state IN ('sending', 'queued')
              RETURNING *`;
            if (row === undefined) return null;
            const settled = yield* fromRow(row);
            return { value: settled, events: [{ _tag: "MemorySaveChanged", save: settled }] as const };
          }),
        ),
      unsent: sqlOrDie(
        sql<Row>`SELECT * FROM memory_saves WHERE state IN ('sending', 'queued') ORDER BY created_at`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
        ),
      ),
      find: (id) =>
        sqlOrDie(
          sql<Row>`SELECT * FROM memory_saves WHERE id = ${id}`.pipe(
            Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : fromRow(row))),
          ),
        ),
      inThread: (threadId) =>
        sqlOrDie(
          sql<Row>`SELECT * FROM memory_saves WHERE thread_id = ${threadId} ORDER BY created_at, id`.pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
          ),
        ),
      // One conditional update, so of two Undos racing for the same save only the first lands.
      markUndone: (id, at) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const [row] = yield* sql<Row>`
              UPDATE memory_saves SET undone_at = ${at}, updated_at = ${at}
              WHERE id = ${id} AND state = 'saved' AND undone_at IS NULL
              RETURNING *`;
            if (row === undefined) return null;
            const undone = yield* fromRow(row);
            return { value: undone, events: [{ _tag: "MemorySaveChanged", save: undone }] as const };
          }),
        ),
    });
  }),
);

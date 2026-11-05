import { MemoryShareLog } from "@hobbots/agents";
import { MemoryShare, type MemoryShareState } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaled } from "./journal.ts";
import { beginMemoryCall, type MemoryCallRow, memoryCallColumns, memoryCallFields } from "./memory-calls.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface Row extends MemoryCallRow {
  readonly through: string;
  readonly edited: number | boolean;
  readonly previous: string | null;
  readonly decidedAt: string | null;
}

const decodeShare = Schema.decodeUnknownEffect(MemoryShare);

const fromRow = (row: Row) =>
  decodeShare({
    ...memoryCallFields(row),
    through: row.through,
    edited: Boolean(row.edited),
    previous: row.previous,
    decidedAt: row.decidedAt,
  }).pipe(Effect.orDie);

const toRow = (share: MemoryShare) => ({
  ...memoryCallColumns(share),
  through: share.through,
  edited: share.edited ? 1 : 0,
  previous: share.previous,
  decided_at: share.decidedAt,
});

const OPEN: ReadonlyArray<MemoryShareState> = ["sending", "waiting"];

/**
 * The SQL record of memory shares (migration 0059), keyed by hob, work and key, as saves are. A
 * share is recorded and journaled in one transaction, with the journal's head taken first, so two
 * calls with one key take turns on PostgreSQL and only the first is recorded. Every later change is
 * one conditional update, so of two decisions racing for a share only the first lands.
 */
export const MemoryShareLogLive = Layer.effect(
  MemoryShareLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    const rows = (found: ReadonlyArray<Row>) => Effect.forEach(found, fromRow);

    return MemoryShareLog.of({
      begin: (share, also) =>
        Effect.map(
          beginMemoryCall<Row, MemoryShare>(
            sql,
            "memory_shares",
            share,
            also,
            { columns: toRow(share), recorded: { _tag: "MemoryShareRequested", share } },
            fromRow,
          ),
          (started) => (started._tag === "Existing" ? { _tag: "Existing", share: started.call } : started),
        ),
      move: (share, from) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const row = toRow(share);
            const [updated] = yield* sql<Row>`
              UPDATE memory_shares SET
                markdown = ${row.markdown}, state = ${row.state}, through = ${row.through},
                edited = ${row.edited}, version = ${row.version}, previous = ${row.previous},
                updated_at = ${row.updated_at}, decided_at = ${row.decided_at}
              WHERE id = ${share.id} AND ${sql.in("state", [...from])}
              RETURNING *`;
            if (updated === undefined) return null;
            const moved = yield* fromRow(updated);
            return { value: moved, events: [{ _tag: "MemoryShareChanged", share: moved }] as const };
          }),
        ),
      get: (id) =>
        sqlOrDie(
          sql<Row>`SELECT * FROM memory_shares WHERE id = ${id}`.pipe(
            Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : Effect.map(fromRow(row), Option.some))),
          ),
        ),
      list: (decided) =>
        sqlOrDie(
          Effect.gen(function* () {
            const open = yield* sql<Row>`SELECT * FROM memory_shares
              WHERE ${sql.in("state", [...OPEN])} ORDER BY created_at`;
            const closed =
              decided <= 0
                ? []
                : yield* sql<Row>`SELECT * FROM memory_shares
                    WHERE ${sql.in("state", ["shared", "kept", "undone"])}
                    ORDER BY updated_at DESC LIMIT ${decided}`;
            return [...(yield* rows(open)), ...(yield* rows(closed))];
          }),
        ),
    });
  }),
);

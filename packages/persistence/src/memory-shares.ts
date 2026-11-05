import { MemoryShareLog } from "@hobbots/agents";
import { MemoryShare, type MemoryShareState } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { lockJournal, makeJournaled } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface Row {
  readonly id: string;
  readonly agentId: string;
  readonly scope: string;
  readonly callKey: string;
  readonly input: string;
  readonly memoryScope: string;
  readonly path: string;
  readonly markdown: string;
  readonly tags: string;
  readonly state: string;
  readonly through: string;
  readonly edited: number | boolean;
  readonly version: string | null;
  readonly previous: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

const decodeShare = Schema.decodeUnknownEffect(MemoryShare);

const fromRow = (row: Row) =>
  decodeShare({
    id: row.id,
    agentId: row.agentId,
    work: row.scope,
    key: row.callKey,
    input: row.input,
    scope: JSON.parse(row.memoryScope),
    path: row.path,
    markdown: row.markdown,
    tags: JSON.parse(row.tags),
    state: row.state,
    through: row.through,
    edited: Boolean(row.edited),
    version: row.version,
    previous: row.previous,
    threadId: row.threadId,
    messageId: row.messageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
  }).pipe(Effect.orDie);

const toRow = (share: MemoryShare) => ({
  id: share.id,
  agent_id: share.agentId,
  scope: share.work,
  call_key: share.key,
  input: share.input,
  memory_scope: JSON.stringify(share.scope),
  path: share.path,
  markdown: share.markdown,
  tags: JSON.stringify(share.tags),
  state: share.state,
  through: share.through,
  edited: share.edited ? 1 : 0,
  version: share.version,
  previous: share.previous,
  thread_id: share.threadId,
  message_id: share.messageId,
  created_at: share.createdAt,
  updated_at: share.updatedAt,
  decided_at: share.decidedAt,
});

const OPEN: ReadonlyArray<MemoryShareState> = ["sending", "waiting"];

/**
 * The SQL record of memory shares (migration 0058), keyed by hob, work and key, as saves are. A
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
        Effect.gen(function* () {
          yield* lockJournal(sql);
          const [stored] = yield* sql<Row>`SELECT * FROM memory_shares
            WHERE agent_id = ${share.agentId} AND ${sql.in("scope", [share.work, also ?? share.work])}
              AND call_key = ${share.key}
            ORDER BY created_at LIMIT 1`;
          if (stored !== undefined) return { _tag: "Existing", share: yield* fromRow(stored) } as const;
          const committed = yield* journaled(1, () =>
            sql`INSERT INTO memory_shares ${sql.insert(toRow(share))}`.pipe(
              Effect.as({ value: share, events: [{ _tag: "MemoryShareRequested", share }] as const }),
            ),
          );
          const entries = Option.isSome(committed) ? committed.value.entries : [];
          return { _tag: "Started", entries } as const;
        }).pipe(sql.withTransaction, sqlOrDie),
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

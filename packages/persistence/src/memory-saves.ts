import { MemorySaves } from "@hobbots/agents";
import { MemorySave } from "@hobbots/domain";
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
  readonly version: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const decodeSave = Schema.decodeUnknownEffect(MemorySave);

const fromRow = (row: Row) =>
  decodeSave({
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
    version: row.version,
    threadId: row.threadId,
    messageId: row.messageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.orDie);

const toRow = (save: MemorySave) => ({
  id: save.id,
  agent_id: save.agentId,
  scope: save.work,
  call_key: save.key,
  input: save.input,
  memory_scope: JSON.stringify(save.scope),
  path: save.path,
  markdown: save.markdown,
  tags: JSON.stringify(save.tags),
  state: save.state,
  version: save.version,
  thread_id: save.threadId,
  message_id: save.messageId,
  created_at: save.createdAt,
  updated_at: save.updatedAt,
});

/**
 * The SQL record of memory saves (migration 0054), keyed by hob, work and key. A save is recorded
 * and journaled in one transaction (ADR 028: the journal is the outbox), with the journal's head
 * taken first, so two calls with one key take turns on PostgreSQL and only the first is recorded.
 */
export const MemorySavesLive = Layer.effect(
  MemorySaves,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    const find = (save: MemorySave, also: string | undefined) =>
      sql<Row>`SELECT * FROM memory_saves
        WHERE agent_id = ${save.agentId} AND ${sql.in("scope", [save.work, also ?? save.work])}
          AND call_key = ${save.key}
        ORDER BY created_at LIMIT 1`;

    return MemorySaves.of({
      begin: (save, also) =>
        Effect.gen(function* () {
          yield* lockJournal(sql);
          const [stored] = yield* find(save, also);
          if (stored !== undefined) return { _tag: "Existing", save: yield* fromRow(stored) } as const;
          const committed = yield* journaled(1, () =>
            sql`INSERT INTO memory_saves ${sql.insert(toRow(save))}`.pipe(
              Effect.as({ value: save, events: [{ _tag: "MemorySaveRecorded", save }] as const }),
            ),
          );
          const entries = Option.isSome(committed) ? committed.value.entries : [];
          return { _tag: "Started", entries } as const;
        }).pipe(sql.withTransaction, sqlOrDie),
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
    });
  }),
);

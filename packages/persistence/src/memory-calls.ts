import type { EventEnvelope, JournaledEvent, MemorySave, MemoryShare } from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { lockJournal, makeJournaled } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

/**
 * What a hob's memory saves (migration 0055) and shares (migration 0059) record alike: the call, keyed
 * by hob, work and key, the page it carries, and where it came from.
 */
export interface MemoryCallRow {
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

type MemoryCall = MemorySave | MemoryShare;

/** A row's shared columns as the fields of a save or a share, for its schema to decode. */
export const memoryCallFields = (row: MemoryCallRow) => ({
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
});

/** A save's or a share's shared fields as their columns. */
export const memoryCallColumns = (call: MemoryCall) => ({
  id: call.id,
  agent_id: call.agentId,
  scope: call.work,
  call_key: call.key,
  input: call.input,
  memory_scope: JSON.stringify(call.scope),
  path: call.path,
  markdown: call.markdown,
  tags: JSON.stringify(call.tags),
  state: call.state,
  version: call.version,
  thread_id: call.threadId,
  message_id: call.messageId,
  created_at: call.createdAt,
  updated_at: call.updatedAt,
});

/** The first call the hob made with the same key, in the same work or in `also`. */
const findMemoryCall = <Row extends MemoryCallRow>(
  sql: SqlClient.SqlClient,
  table: "memory_saves" | "memory_shares",
  call: MemoryCall,
  also: string | undefined,
) =>
  sql<Row>`SELECT * FROM ${sql(table)}
    WHERE agent_id = ${call.agentId} AND ${sql.in("scope", [call.work, also ?? call.work])}
      AND call_key = ${call.key}
    ORDER BY created_at LIMIT 1`;

/**
 * Records a save or a share and journals `recorded` in one transaction (ADR 028: the journal is the
 * outbox), unless the hob made a call with the same key in the same work or in `also`: that one is
 * answered instead. The journal's head is taken first, so two calls with one key take turns on
 * PostgreSQL and only the first is recorded.
 */
export const beginMemoryCall = <Row extends MemoryCallRow, C extends MemoryCall>(
  sql: SqlClient.SqlClient,
  table: "memory_saves" | "memory_shares",
  call: C,
  also: string | undefined,
  write: { readonly columns: Record<string, unknown>; readonly recorded: JournaledEvent },
  decode: (row: Row) => Effect.Effect<C>,
): Effect.Effect<
  | { readonly _tag: "Existing"; readonly call: C }
  | { readonly _tag: "Started"; readonly entries: ReadonlyArray<EventEnvelope> }
> =>
  Effect.gen(function* () {
    yield* lockJournal(sql);
    const [stored] = yield* findMemoryCall<Row>(sql, table, call, also);
    if (stored !== undefined) return { _tag: "Existing", call: yield* decode(stored) } as const;
    const committed = yield* makeJournaled(sql)(1, () =>
      sql`INSERT INTO ${sql(table)} ${sql.insert(write.columns)}`.pipe(
        Effect.as({ value: call, events: [write.recorded] }),
      ),
    );
    return { _tag: "Started", entries: Option.isSome(committed) ? committed.value.entries : [] } as const;
  }).pipe(sql.withTransaction, sqlOrDie);

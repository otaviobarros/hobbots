import {
  BackpackDisposition,
  BackpackItem,
  BackpackItemId,
  BackpackPayload,
  backpackPriority,
  isActionableKind,
  type JournaledEvent,
  type NewBackpackItem,
} from "@hobbots/domain";
import { backpackItemsFor, type ToolCallSource, tasksTouched } from "@hobbots/inbox";
import { Context, DateTime, Duration, Effect, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { makeTaskReads } from "./task-rows.ts";

/**
 * The hob tool call the current change runs in, if any. The Task tool ledger sets it around a
 * call's writes, so the items those writes record take their dedupe key from the call's key.
 */
export const CurrentToolCall = Context.Reference<ToolCallSource | null>("@hobbots/persistence/CurrentToolCall", {
  defaultValue: () => null,
});

/**
 * Whether the approval requests the current change decides or expires have no live turn waiting
 * for them, so their outcomes are recorded in their hobs' backpacks (ADR 019).
 */
export const UnwaitedApprovals = Context.Reference<boolean>("@hobbots/persistence/UnwaitedApprovals", {
  defaultValue: () => false,
});

/**
 * Leases are timed by the database's clock, so every hub process that shares a database agrees on
 * when one runs out (ADR 019). Times are ISO 8601 text to the millisecond, as the app writes them.
 */
export const makeDatabaseClock = (sql: SqlClient.SqlClient) => {
  /** The time `lease` from now. */
  const until = (lease: Duration.Input) => {
    const seconds = Duration.toMillis(lease) / 1000;
    return sql.onDialectOrElse({
      pg: () =>
        sql`to_char((clock_timestamp() + make_interval(secs => ${seconds}::double precision)) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      orElse: () => sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`+${seconds} seconds`})`,
    });
  };
  /** Whether the row's lease is still running. */
  const leaseLive = sql.onDialectOrElse({
    pg: () => sql.literal("lease_expires_at::timestamptz > clock_timestamp()"),
    orElse: () => sql.literal("lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
  });
  return { until, leaseLive };
};

const encodePayload = Schema.encodeSync(Schema.fromJsonString(BackpackPayload));
const encodeDisposition = Schema.encodeSync(Schema.fromJsonString(BackpackDisposition));
const decodeItem = Schema.decodeUnknownEffect(BackpackItem);

type Row = Record<string, unknown>;

const json = (value: unknown) => (value == null ? null : JSON.parse(String(value)));

export const dispositionColumn = (disposition: BackpackDisposition) => encodeDisposition(disposition);

/**
 * Reads items with their deliveries (migration 0026). A row that does not decode is a defect: the
 * hub wrote it. PostgreSQL reads BIGINT as a bigint; every token and revision fits a number.
 */
export const makeItemReads = (sql: SqlClient.SqlClient) => {
  const toItems = (rows: ReadonlyArray<Row>) =>
    Effect.gen(function* () {
      if (rows.length === 0) return [];
      const deliveries = yield* sql<Row>`SELECT * FROM backpack_deliveries
        WHERE ${sql.in(
          "item_id",
          rows.map((row) => String(row.id)),
        )} ORDER BY number`;
      return yield* Effect.forEach(rows, (row) =>
        decodeItem({
          ...row,
          actionable: Number(row.actionable) === 1,
          priority: Number(row.priority),
          payload: json(row.payload),
          disposition: json(row.disposition),
          fencingToken: Number(row.claimToken),
          claim:
            row.claimOwner == null
              ? null
              : { owner: row.claimOwner, token: Number(row.claimToken), leaseExpiresAt: row.leaseExpiresAt },
          deliveries: deliveries
            .filter((delivery) => delivery.itemId === row.id)
            .map((delivery) => ({ ...delivery, number: Number(delivery.number) })),
          revision: Number(row.revision),
        }).pipe(Effect.orDie),
      );
    });
  const item = (id: string) =>
    sql<Row>`SELECT * FROM backpack_items WHERE id = ${id}`.pipe(
      Effect.flatMap(toItems),
      Effect.map(([found]) => found),
    );
  return { toItems, item };
};

/** The trees a change's events touch, as the change left them, for `backpackItemsFor`. */
const contextOf = (sql: SqlClient.SqlClient, events: ReadonlyArray<JournaledEvent>) =>
  Effect.gen(function* () {
    const touched = tasksTouched(events);
    const approvalOutcomes = yield* UnwaitedApprovals;
    const toolCall = yield* CurrentToolCall;
    if (touched.length === 0) return approvalOutcomes ? { tasks: [], quests: [], toolCall, approvalOutcomes } : null;
    const read = makeTaskReads(sql);
    const roots = yield* sql<{ readonly rootId: string }>`SELECT DISTINCT root_id FROM tasks
      WHERE ${sql.in("id", touched)}`;
    const tasks = (yield* Effect.forEach(roots, (root) => read.treeOf(root.rootId))).flat();
    const quests = tasks.length === 0 ? [] : yield* read.questsOn(tasks.map((task) => task.id));
    return { tasks, quests, toolCall, approvalOutcomes };
  });

/** Leaves out the items whose recipient already holds one with the same key. */
const unrecorded = (sql: SqlClient.SqlClient, items: ReadonlyArray<NewBackpackItem>) =>
  Effect.gen(function* () {
    if (items.length === 0) return [];
    const keys = [...new Set(items.map((item) => item.dedupeKey))];
    const stored = yield* sql<{
      readonly recipientId: string;
      readonly dedupeKey: string;
    }>`SELECT recipient_id, dedupe_key
      FROM backpack_items WHERE ${sql.in("dedupe_key", keys)}`;
    const seen = new Set(stored.map((row) => `${row.recipientId}\n${row.dedupeKey}`));
    return items.filter((item) => {
      const pair = `${item.recipientId}\n${item.dedupeKey}`;
      if (seen.has(pair)) return false;
      seen.add(pair);
      return true;
    });
  });

/**
 * Records the backpack items a change's events call for, inside the change's transaction, at the
 * journal sequences from `first` on, and returns the events that announce them (ADR 019). A
 * repeated key records nothing. Only for use within `sql.withTransaction`, after the change wrote.
 */
export const recordBackpackItems = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const context = yield* contextOf(sql, events);
    if (context === null) return [];
    const fresh = yield* unrecorded(sql, backpackItemsFor(events, context));
    const at = DateTime.formatIso(yield* DateTime.now);
    return yield* Effect.forEach(fresh, (draft, index) =>
      Effect.gen(function* () {
        const kind = draft.payload._tag;
        const item = new BackpackItem({
          ...draft,
          id: BackpackItemId.make(crypto.randomUUID()),
          kind,
          actionable: isActionableKind(kind),
          priority: backpackPriority(kind),
          state: "pending",
          claim: null,
          fencingToken: 0,
          deliveries: [],
          disposition: null,
          error: null,
          createdAt: at,
          updatedAt: at,
          revision: first + index,
        });
        yield* sql`INSERT INTO backpack_items ${sql.insert({
          id: item.id,
          recipient_id: item.recipientId,
          kind: item.kind,
          actionable: item.actionable ? 1 : 0,
          priority: item.priority,
          state: item.state,
          task_id: item.taskId,
          quest_id: item.questId,
          attempt_id: item.attemptId,
          thread_id: item.threadId,
          dedupe_key: item.dedupeKey,
          payload: encodePayload(item.payload),
          not_before: item.notBefore,
          claim_owner: null,
          claim_token: 0,
          lease_expires_at: null,
          disposition: null,
          error: null,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
          revision: item.revision,
          recorded_sequence: item.revision,
        })}`;
        return { _tag: "BackpackItemRecorded", item } as const;
      }),
    );
  });

import { sessionActor } from "@hobbots/agents";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { memberUnreadCount, unreadReplies } from "./thread-columns.ts";

// Unread counts per thread, from the thread's own read marker as the hub kept it before migration
// 0115 and from the member row of the person asking after it (ADR 039, read markers per member;
// #1454), so a dry run on a copy of a real database can show they read the same.

/** One thread's unread replies. */
export interface ThreadUnread {
  readonly threadId: string;
  readonly title: string;
  readonly agentId: string;
  readonly unread: number;
}

interface Row {
  readonly threadId: unknown;
  readonly title: unknown;
  readonly agentId: unknown;
  readonly unread: unknown;
}

const rows = (read: ReadonlyArray<Row>): ReadonlyArray<ThreadUnread> =>
  read.map((row) => ({
    threadId: String(row.threadId),
    title: String(row.title),
    agentId: String(row.agentId),
    unread: Number(row.unread),
  }));

/** Whether the threads still keep their own read marker: the database is from before migration 0115. */
export const keepsThreadMarker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql.onDialectOrElse({
    pg: () =>
      sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'threads' AND column_name = 'read_revision'`,
    orElse: () => sql`SELECT 1 FROM pragma_table_info('threads') WHERE name = 'read_revision'`,
  });
  return found.length > 0;
});

/** Each thread's unread replies by its own read marker, as the hub counted them before migration 0115. */
export const unreadByThreadMarker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return rows(
    yield* sql<Row>`SELECT threads.id AS thread_id, threads.title, threads.agent_id,
        (SELECT COUNT(*) ${unreadReplies(sql, "threads.id", "threads.read_revision")}) AS unread
      FROM threads ORDER BY threads.id`,
  );
});

/** Each thread's unread replies for the person asking, by their member row; a thread they are not in counts none. */
export const unreadByMember = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reader = yield* sessionActor;
  return rows(
    yield* sql<Row>`SELECT threads.id AS thread_id, threads.title, threads.agent_id,
        COALESCE((SELECT ${memberUnreadCount(sql)} FROM thread_members WHERE thread_members.thread_id = threads.id
          AND actor_kind = ${reader.kind} AND actor_id = ${reader.id}), 0) AS unread
      FROM threads ORDER BY threads.id`,
  );
});

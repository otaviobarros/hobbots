import type { SqlClient } from "effect/sql";

// Columns a thread is read with that are worked out from other tables, never stored on it.

/**
 * Whether the hob wrote in the thread since you last read it, 1 or 0: a reply that ended with text,
 * or that failed, written after `read_revision` (ADR 027). That counts a reply continued in place
 * after you read it, since its message takes a new revision. A reply still under way waits until it
 * ends, and your own messages and a lead's quiet progress (#1006) never count.
 */
export const unreadExpression = (sql: SqlClient.SqlClient) =>
  sql`(CASE WHEN EXISTS (SELECT 1 FROM messages u
    WHERE u.thread_id = threads.id AND u.role = 'assistant' AND u.revision > COALESCE(threads.read_revision, 0)
      AND u.status NOT IN ('queued', 'streaming', 'stopping') AND u.quiet = 0
      AND (trim(u.content) <> '' OR u.status = 'failed')) THEN 1 ELSE 0 END)`;

/** Whether the thread is unread, as `unread`. */
export const unreadColumn = (sql: SqlClient.SqlClient) => sql`${unreadExpression(sql)} AS unread`;

/**
 * The thread's live chapter, as `live_chapter_id`, and how many chapters were merged into it, as
 * `live_chapter_merges` (ADR 037, migration 0098).
 */
export const liveChapterColumn = (sql: SqlClient.SqlClient) =>
  sql`(SELECT c.id FROM chapters c WHERE c.thread_id = threads.id AND c.state = 'live') AS live_chapter_id,
    (SELECT COUNT(*) FROM merged_chapters mc JOIN chapters c ON c.id = mc.into_id
      WHERE c.thread_id = threads.id AND c.state = 'live') AS live_chapter_merges`;

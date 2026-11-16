import type { SqlClient } from "effect/sql";

// Columns a channel is read with that are worked out from other tables, never stored on it, and
// whether a member has it unread.

/**
 * The replies unread in channel `channel` for a read marker `marker`, both column references of the
 * outer query, as the FROM and WHERE of a subquery (ADR 027, ADR 039): a reply that ended with text,
 * or that failed, written after the marker. That counts a reply continued in place after it was
 * read, since its message takes a new revision. A reply still under way waits until it ends, and a
 * person's own messages and a lead's quiet progress (#1006) never count.
 */
const unreadReplies = (sql: SqlClient.SqlClient, channel: string, marker: string) =>
  sql`FROM messages u WHERE u.channel_id = ${sql.literal(channel)} AND u.role = 'assistant'
      AND u.revision > COALESCE(${sql.literal(marker)}, 0)
      AND u.status NOT IN ('queued', 'streaming', 'stopping') AND u.quiet = 0
      AND (trim(u.content) <> '' OR u.status = 'failed')`;

const memberReplies = (sql: SqlClient.SqlClient) =>
  unreadReplies(sql, "channel_members.channel_id", "channel_members.read_revision");

/** Whether a row of `channel_members` has a reply unread in its channel. */
export const memberUnread = (sql: SqlClient.SqlClient) => sql`EXISTS (SELECT 1 ${memberReplies(sql)})`;

/** How many replies a row of `channel_members` has unread in its channel. */
export const memberUnreadCount = (sql: SqlClient.SqlClient) => sql`(SELECT COUNT(*) ${memberReplies(sql)})`;

/**
 * The channel's live chapter, as `live_chapter_id`, and how many chapters were merged into it, as
 * `live_chapter_merges` (ADR 037, migration 0099).
 */
export const liveChapterColumn = (sql: SqlClient.SqlClient) =>
  sql`(SELECT c.id FROM chapters c WHERE c.channel_id = channels.id AND c.state = 'live') AS live_chapter_id,
    (SELECT COUNT(*) FROM merged_chapters mc JOIN chapters c ON c.id = mc.into_id
      WHERE c.channel_id = channels.id AND c.state = 'live') AS live_chapter_merges`;

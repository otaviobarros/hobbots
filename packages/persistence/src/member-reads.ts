import { sessionActor } from "@hobbots/agents";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { memberUnreadCount, unreadReplies } from "./channel-columns.ts";

// Unread counts per channel, from the channel's own read marker as the hub kept it before migration
// 20261114004500 and from the member row of the person asking after it (ADR 039, read markers per member;
// #1454), so a dry run on a copy of a real database can show they read the same.

/** One channel's unread replies. */
export interface ChannelUnread {
  readonly channelId: string;
  readonly title: string;
  readonly agentId: string;
  readonly unread: number;
}

interface Row {
  readonly channelId: unknown;
  readonly title: unknown;
  readonly agentId: unknown;
  readonly unread: unknown;
}

const rows = (read: ReadonlyArray<Row>): ReadonlyArray<ChannelUnread> =>
  read.map((row) => ({
    channelId: String(row.channelId),
    title: String(row.title),
    agentId: String(row.agentId),
    unread: Number(row.unread),
  }));

/** Whether the channels still keep their own read marker: the database is from before migration 20261114004500. */
export const keepsChannelMarker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql.onDialectOrElse({
    pg: () =>
      sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'channels' AND column_name = 'read_revision'`,
    orElse: () => sql`SELECT 1 FROM pragma_table_info('channels') WHERE name = 'read_revision'`,
  });
  return found.length > 0;
});

/** Each channel's unread replies by its own read marker, as the hub counted them before migration 20261114004500. */
export const unreadByChannelMarker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return rows(
    yield* sql<Row>`SELECT channels.id AS channel_id, channels.title, channels.agent_id,
        (SELECT COUNT(*) ${unreadReplies(sql, "channels.id", "channels.read_revision")}) AS unread
      FROM channels ORDER BY channels.id`,
  );
});

/** Each channel's unread replies for the person asking, by their member row; a channel they are not in counts none. */
export const unreadByMember = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reader = yield* sessionActor;
  return rows(
    yield* sql<Row>`SELECT channels.id AS channel_id, channels.title, channels.agent_id,
        COALESCE((SELECT ${memberUnreadCount(sql)} FROM channel_members WHERE channel_members.channel_id = channels.id
          AND actor_kind = ${reader.kind} AND actor_id = ${reader.id}), 0) AS unread
      FROM channels ORDER BY channels.id`,
  );
});

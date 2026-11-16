import {
  type MemoryCaptureExclusions,
  MemoryCaptureLog,
  type MemoryCaptureSession,
  type MemoryCaptureWork,
  PrivateCamps,
} from "@hobbots/agents";
import { AgentId, ChannelId, Message, TaskId } from "@hobbots/domain";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { EventJournal } from "./journal.ts";
import { messageRows } from "./repositories.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface SessionRow {
  readonly sessionId: string;
  readonly agentId: string;
  readonly lastAt: string;
  readonly lastKey: string;
}

const sessionOf = (row: SessionRow): MemoryCaptureSession => ({
  sessionId: row.sessionId,
  agentId: AgentId.make(row.agentId),
  lastAt: row.lastAt,
  lastKey: row.lastKey,
});

/**
 * The capture worker's cursor and open sessions (migrations 0056, 0061 and
 * 20261114150837_memory_capture_sessions_per_hob, ADR 028), each session under its hob (ADR 039). Journal compaction reads
 * the same row, and keeps every entry after the cursor while it holds.
 */
export const MemoryCaptureLive = Layer.effect(
  MemoryCaptureLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* EventJournal;

    /** The camps private as of the cursor, which capture follows along the journal (ADR 037). */
    const privateAtCursor = Effect.map(
      sql<{ readonly channelId: string }>`SELECT channel_id FROM memory_capture_private_channels ORDER BY channel_id`,
      (rows) => rows.map((row) => ChannelId.make(row.channelId)),
    );

    /** The units kept out of memory for good (ADR 037). */
    const excluded = Effect.map(
      sql<{ readonly unit: string }>`SELECT unit FROM memory_capture_excluded ORDER BY unit`,
      (rows) => rows.map((row) => row.unit),
    );
    const exclusionsAtCursor = Effect.all({ privateChannels: privateAtCursor, excluded });

    const saveExclusions = ({ privateChannels, excluded: added }: MemoryCaptureExclusions) =>
      Effect.gen(function* () {
        for (const unit of added) {
          yield* sql`INSERT INTO memory_capture_excluded ${sql.insert({ unit })} ON CONFLICT (unit) DO NOTHING`;
        }
        yield* sql`DELETE FROM memory_capture_private_channels`;
        for (const channelId of privateChannels)
          yield* sql`INSERT INTO memory_capture_private_channels ${sql.insert({ channel_id: channelId })}`;
      });

    const hold = Effect.gen(function* () {
      const [row] = yield* sql<{ readonly sequence: unknown; readonly holding: unknown; readonly sinceAt: unknown }>`
        SELECT sequence, holding, since_at FROM memory_capture WHERE id = 1`;
      if (Number(row?.holding) === 1) {
        const sessions = yield* sql<SessionRow>`SELECT * FROM memory_capture_sessions ORDER BY session_id, agent_id`;
        return {
          sequence: Number(row?.sequence),
          since: String(row?.sinceAt),
          sessions: sessions.map(sessionOf),
          exclusions: yield* exclusionsAtCursor,
        };
      }
      yield* sql`DELETE FROM memory_capture_sessions`;
      // Starting at the head, capture takes the camps private now, and keeps out what it kept out before.
      yield* sql`DELETE FROM memory_capture_private_channels`;
      yield* sql`INSERT INTO memory_capture_private_channels (channel_id) SELECT id FROM channels WHERE private = 1`;
      const since = DateTime.formatIso(yield* DateTime.now);
      const [moved] = yield* sql<{ readonly sequence: unknown }>`UPDATE memory_capture
        SET sequence = (SELECT sequence FROM event_journal_head WHERE id = 1), holding = 1, since_at = ${since}
        WHERE id = 1 RETURNING sequence`;
      return { sequence: Number(moved?.sequence), since, sessions: [], exclusions: yield* exclusionsAtCursor };
    }).pipe(sql.withTransaction, sqlOrDie);

    /** Of `work`, the camps private now, and the channel of each Task in one (ADR 037). */
    const privacy = (work: MemoryCaptureWork) =>
      Effect.gen(function* () {
        const tasks =
          work.taskIds.size === 0
            ? []
            : yield* sql<{ readonly id: string; readonly channelId: string }>`SELECT id, channel_id FROM tasks
                WHERE channel_id IS NOT NULL AND ${sql.in("id", [...work.taskIds])}`;
        const channelIds = [...new Set([...work.channelIds, ...tasks.map((row) => row.channelId)])];
        const rows =
          channelIds.length === 0
            ? []
            : yield* sql<{ readonly id: string }>`SELECT id FROM channels
                WHERE private = 1 AND ${sql.in("id", channelIds)}`;
        return {
          privateNow: new Set(rows.map((row) => ChannelId.make(row.id))),
          taskChannels: new Map(tasks.map((row) => [TaskId.make(row.id), ChannelId.make(row.channelId)] as const)),
        };
      }).pipe(sqlOrDie);

    const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(Message));
    /** The messages of `ids` as stored now, for the hobs that took a turn on them (ADR 039). */
    const messages = (ids: ReadonlyArray<string>) =>
      ids.length === 0
        ? Effect.succeed([])
        : sql`SELECT * FROM messages WHERE ${sql.in("id", [...ids])}`.pipe(
            Effect.map(messageRows),
            Effect.flatMap(decodeMessages),
            Effect.orDie,
          );

    return MemoryCaptureLog.of({
      privacy,
      messages,
      hold,
      release: sqlOrDie(sql`UPDATE memory_capture SET holding = 0 WHERE id = 1`.pipe(Effect.asVoid)),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      save: (sequence, active, ended, exclusions) =>
        Effect.gen(function* () {
          yield* sql`UPDATE memory_capture SET sequence = ${sequence} WHERE id = 1`;
          yield* saveExclusions(exclusions);
          for (const session of [...ended, ...active]) {
            yield* sql`DELETE FROM memory_capture_sessions
              WHERE agent_id = ${session.agentId} AND session_id = ${session.sessionId}`;
          }
          for (const session of active) {
            yield* sql`INSERT INTO memory_capture_sessions ${sql.insert({
              session_id: session.sessionId,
              agent_id: session.agentId,
              last_at: session.lastAt,
              last_key: session.lastKey,
            })}`;
          }
        }).pipe(sql.withTransaction, sqlOrDie),
    });
  }),
);

/** Whether a turn's work is in a private camp (ADR 037), read from its channel, or its Task's. */
export const PrivateCampsLive = Layer.effect(
  PrivateCamps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return PrivateCamps.of({
      holds: ({ channelId, taskId }) =>
        Effect.gen(function* () {
          if (channelId !== null) {
            const [row] = yield* sql`SELECT 1 AS found FROM channels WHERE id = ${channelId} AND private = 1`;
            if (row !== undefined) return true;
          }
          if (taskId === undefined) return false;
          const [row] = yield* sql`SELECT 1 AS found FROM tasks JOIN channels ON channels.id = tasks.channel_id
            WHERE tasks.id = ${taskId} AND channels.private = 1`;
          return row !== undefined;
        }).pipe(sqlOrDie),
    });
  }),
);

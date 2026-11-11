import {
  type MemoryCaptureExclusions,
  MemoryCaptureLog,
  type MemoryCaptureSession,
  type MemoryCaptureWork,
  PrivateCamps,
} from "@hobbots/agents";
import { AgentId, TaskId, ThreadId } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { EventJournal } from "./journal.ts";
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
 * The capture worker's cursor and open sessions (migrations 0056 and 0061, ADR 028). Journal compaction reads
 * the same row, and keeps every entry after the cursor while it holds.
 */
export const MemoryCaptureLive = Layer.effect(
  MemoryCaptureLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* EventJournal;

    /** The camps private as of the cursor, which capture follows along the journal (ADR 037). */
    const privateAtCursor = Effect.map(
      sql<{ readonly threadId: string }>`SELECT thread_id FROM memory_capture_private_threads ORDER BY thread_id`,
      (rows) => rows.map((row) => ThreadId.make(row.threadId)),
    );

    /** The units kept out of memory for good (ADR 037). */
    const excluded = Effect.map(
      sql<{ readonly unit: string }>`SELECT unit FROM memory_capture_excluded ORDER BY unit`,
      (rows) => rows.map((row) => row.unit),
    );
    const exclusionsAtCursor = Effect.all({ privateThreads: privateAtCursor, excluded });

    const saveExclusions = ({ privateThreads, excluded: added }: MemoryCaptureExclusions) =>
      Effect.gen(function* () {
        for (const unit of added) {
          yield* sql`INSERT INTO memory_capture_excluded ${sql.insert({ unit })} ON CONFLICT (unit) DO NOTHING`;
        }
        yield* sql`DELETE FROM memory_capture_private_threads`;
        for (const threadId of privateThreads)
          yield* sql`INSERT INTO memory_capture_private_threads ${sql.insert({ thread_id: threadId })}`;
      });

    const hold = Effect.gen(function* () {
      const [row] = yield* sql<{ readonly sequence: unknown; readonly holding: unknown }>`
        SELECT sequence, holding FROM memory_capture WHERE id = 1`;
      if (Number(row?.holding) === 1) {
        const sessions = yield* sql<SessionRow>`SELECT * FROM memory_capture_sessions ORDER BY session_id`;
        return {
          sequence: Number(row?.sequence),
          sessions: sessions.map(sessionOf),
          exclusions: yield* exclusionsAtCursor,
        };
      }
      yield* sql`DELETE FROM memory_capture_sessions`;
      // Starting at the head, capture takes the camps private now, and keeps out what it kept out before.
      yield* sql`DELETE FROM memory_capture_private_threads`;
      yield* sql`INSERT INTO memory_capture_private_threads (thread_id) SELECT id FROM threads WHERE private = 1`;
      const [moved] = yield* sql<{ readonly sequence: unknown }>`UPDATE memory_capture
        SET sequence = (SELECT sequence FROM event_journal_head WHERE id = 1), holding = 1
        WHERE id = 1 RETURNING sequence`;
      return { sequence: Number(moved?.sequence), sessions: [], exclusions: yield* exclusionsAtCursor };
    }).pipe(sql.withTransaction, sqlOrDie);

    /** Of `work`, the camps private now, and the thread of each Task in one (ADR 037). */
    const privacy = (work: MemoryCaptureWork) =>
      Effect.gen(function* () {
        const tasks =
          work.taskIds.size === 0
            ? []
            : yield* sql<{ readonly id: string; readonly threadId: string }>`SELECT id, thread_id FROM tasks
                WHERE thread_id IS NOT NULL AND ${sql.in("id", [...work.taskIds])}`;
        const threadIds = [...new Set([...work.threadIds, ...tasks.map((row) => row.threadId)])];
        const rows =
          threadIds.length === 0
            ? []
            : yield* sql<{ readonly id: string }>`SELECT id FROM threads
                WHERE private = 1 AND ${sql.in("id", threadIds)}`;
        return {
          privateNow: new Set(rows.map((row) => ThreadId.make(row.id))),
          taskThreads: new Map(tasks.map((row) => [TaskId.make(row.id), ThreadId.make(row.threadId)] as const)),
        };
      }).pipe(sqlOrDie);

    return MemoryCaptureLog.of({
      privacy,
      hold,
      release: sqlOrDie(sql`UPDATE memory_capture SET holding = 0 WHERE id = 1`.pipe(Effect.asVoid)),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      save: (sequence, active, ended, exclusions) =>
        Effect.gen(function* () {
          yield* sql`UPDATE memory_capture SET sequence = ${sequence} WHERE id = 1`;
          yield* saveExclusions(exclusions);
          if (ended.length > 0) yield* sql`DELETE FROM memory_capture_sessions WHERE ${sql.in("session_id", ended)}`;
          for (const session of active) {
            yield* sql`DELETE FROM memory_capture_sessions WHERE session_id = ${session.sessionId}`;
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

/** Whether a turn's work is in a private camp (ADR 037), read from its thread, or its Task's. */
export const PrivateCampsLive = Layer.effect(
  PrivateCamps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return PrivateCamps.of({
      holds: ({ threadId, taskId }) =>
        Effect.gen(function* () {
          if (threadId !== null) {
            const [row] = yield* sql`SELECT 1 AS found FROM threads WHERE id = ${threadId} AND private = 1`;
            if (row !== undefined) return true;
          }
          if (taskId === undefined) return false;
          const [row] = yield* sql`SELECT 1 AS found FROM tasks JOIN threads ON threads.id = tasks.thread_id
            WHERE tasks.id = ${taskId} AND threads.private = 1`;
          return row !== undefined;
        }).pipe(sqlOrDie),
    });
  }),
);

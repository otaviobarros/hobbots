import { MemoryCaptureLog, type MemoryCaptureSession, type MemoryCaptureWork } from "@hobbots/agents";
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

    const hold = Effect.gen(function* () {
      const [row] = yield* sql<{ readonly sequence: unknown; readonly holding: unknown }>`
        SELECT sequence, holding FROM memory_capture WHERE id = 1`;
      if (Number(row?.holding) === 1) {
        const sessions = yield* sql<SessionRow>`SELECT * FROM memory_capture_sessions ORDER BY session_id`;
        return { sequence: Number(row?.sequence), sessions: sessions.map(sessionOf) };
      }
      yield* sql`DELETE FROM memory_capture_sessions`;
      const [moved] = yield* sql<{ readonly sequence: unknown }>`UPDATE memory_capture
        SET sequence = (SELECT sequence FROM event_journal_head WHERE id = 1), holding = 1
        WHERE id = 1 RETURNING sequence`;
      return { sequence: Number(moved?.sequence), sessions: [] };
    }).pipe(sql.withTransaction, sqlOrDie);

    /** Of `work`, the private camps, and the Tasks in one (ADR 037), read now. */
    const privateWork = (work: MemoryCaptureWork) =>
      Effect.gen(function* () {
        const threads =
          work.threadIds.size === 0
            ? []
            : yield* sql<{ readonly id: string }>`SELECT id FROM threads
                WHERE private = 1 AND ${sql.in("id", [...work.threadIds])}`;
        const tasks =
          work.taskIds.size === 0
            ? []
            : yield* sql<{ readonly id: string }>`SELECT tasks.id AS id FROM tasks
                JOIN threads ON threads.id = tasks.thread_id
                WHERE threads.private = 1 AND ${sql.in("tasks.id", [...work.taskIds])}`;
        return {
          threadIds: new Set(threads.map((row) => ThreadId.make(row.id))),
          taskIds: new Set(tasks.map((row) => TaskId.make(row.id))),
        };
      }).pipe(sqlOrDie);

    return MemoryCaptureLog.of({
      privateWork,
      hold,
      release: sqlOrDie(sql`UPDATE memory_capture SET holding = 0 WHERE id = 1`.pipe(Effect.asVoid)),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      save: (sequence, active, ended) =>
        Effect.gen(function* () {
          yield* sql`UPDATE memory_capture SET sequence = ${sequence} WHERE id = 1`;
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

import { MemoryCaptureLog, type MemoryCaptureSession } from "@hobbots/agents";
import { AgentId, ThreadId } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { EventJournal } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface SessionRow {
  readonly threadId: string;
  readonly agentId: string;
  readonly lastAt: string;
  readonly lastKey: string;
}

const sessionOf = (row: SessionRow): MemoryCaptureSession => ({
  threadId: ThreadId.make(row.threadId),
  agentId: AgentId.make(row.agentId),
  lastAt: row.lastAt,
  lastKey: row.lastKey,
});

/**
 * The capture worker's cursor and open sessions (migration 0055, ADR 028). Journal compaction reads
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
        const sessions = yield* sql<SessionRow>`SELECT * FROM memory_capture_sessions ORDER BY thread_id`;
        return { sequence: Number(row?.sequence), sessions: sessions.map(sessionOf) };
      }
      yield* sql`DELETE FROM memory_capture_sessions`;
      const [moved] = yield* sql<{ readonly sequence: unknown }>`UPDATE memory_capture
        SET sequence = (SELECT sequence FROM event_journal_head WHERE id = 1), holding = 1
        WHERE id = 1 RETURNING sequence`;
      return { sequence: Number(moved?.sequence), sessions: [] };
    }).pipe(sql.withTransaction, sqlOrDie);

    return MemoryCaptureLog.of({
      hold,
      release: sqlOrDie(sql`UPDATE memory_capture SET holding = 0 WHERE id = 1`.pipe(Effect.asVoid)),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      save: (sequence, active, ended) =>
        Effect.gen(function* () {
          yield* sql`UPDATE memory_capture SET sequence = ${sequence} WHERE id = 1`;
          if (ended.length > 0) yield* sql`DELETE FROM memory_capture_sessions WHERE ${sql.in("thread_id", ended)}`;
          for (const session of active) {
            yield* sql`DELETE FROM memory_capture_sessions WHERE thread_id = ${session.threadId}`;
            yield* sql`INSERT INTO memory_capture_sessions ${sql.insert({
              thread_id: session.threadId,
              agent_id: session.agentId,
              last_at: session.lastAt,
              last_key: session.lastKey,
            })}`;
          }
        }).pipe(sql.withTransaction, sqlOrDie),
    });
  }),
);

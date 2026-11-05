import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Memory capture (ADR 028). The capture worker reads the event journal after its cursor and sends
// what happened in each thread to memory, moving the cursor once memory acknowledges it. While it
// holds (`holding` is 1), journal compaction keeps every entry after the cursor, however old, so an
// outage costs disk, not memory. It starts at the journal's head and not holding: memory begins with
// what happens after it is first turned on. `memory_capture_sessions` are the threads whose memory
// session is open: when each was last active, by the time of its last captured entry, and the key of
// that entry, which names the session's end.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE memory_capture (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sequence BIGINT NOT NULL,
        holding INTEGER NOT NULL
      )
    `;
  yield* sql`INSERT INTO memory_capture (id, sequence, holding)
    SELECT 1, sequence, 0 FROM event_journal_head WHERE id = 1`;
  yield* sql`
      CREATE TABLE memory_capture_sessions (
        thread_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        last_at TEXT NOT NULL,
        last_key TEXT NOT NULL
      )
    `;
});

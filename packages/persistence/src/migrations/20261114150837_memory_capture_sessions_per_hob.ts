import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql";

// Memory in a shared thread (ADR 039, #1466). A thread with several hobs has a memory session in each
// hob's own memory, named by the thread, so an open session is its hob and its id together. The table
// is made again with both as its key, keeping the sessions open now, each under the hob it was open in.
//
// A hob keeps a person's message once it takes a turn on it, which capture reads from the message
// itself. Capture never read a message written before it last started from the journal's head, so it
// cannot know whether its camp was private then: `since_at` is when that was, and it keeps none of
// those. Not known for a cursor from before, it starts now.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_capture ADD COLUMN since_at TEXT`;
  yield* sql`UPDATE memory_capture SET since_at = ${DateTime.formatIso(yield* DateTime.now)}`;
  yield* sql`
    CREATE TABLE memory_capture_sessions_per_hob (
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_at TEXT NOT NULL,
      last_key TEXT NOT NULL,
      PRIMARY KEY (agent_id, session_id)
    )
  `;
  yield* sql`INSERT INTO memory_capture_sessions_per_hob (agent_id, session_id, last_at, last_key)
    SELECT agent_id, session_id, last_at, last_key FROM memory_capture_sessions`;
  yield* sql`DROP TABLE memory_capture_sessions`;
  yield* sql`ALTER TABLE memory_capture_sessions_per_hob RENAME TO memory_capture_sessions`;
});

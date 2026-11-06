import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Memory sessions outside any chat (ADR 028, #1012). A party member's or a step's Attempt runs in no
// thread, so it gets a memory session of its own, named by the Attempt's id. An open session is now
// a thread's or an Attempt's, so its column is renamed; a thread's session keeps its thread's id.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_capture_sessions RENAME COLUMN thread_id TO session_id`;
});

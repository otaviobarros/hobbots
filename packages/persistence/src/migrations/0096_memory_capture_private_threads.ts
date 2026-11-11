import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The camps that were private as of memory capture's cursor (ADR 037). Capture follows each camp's
// privacy along the journal from there, so an entry written while its camp was private is never sent,
// even once the camp is public again. Starts from the camps private now. Beside it, the units capture
// keeps out of memory for good (`message:<id>`, `attempt:<id>` and so on): each had an entry written in
// a private camp, and a later entry carries all of it again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_capture_private_threads (thread_id TEXT PRIMARY KEY)`;
  yield* sql`INSERT INTO memory_capture_private_threads (thread_id) SELECT id FROM threads WHERE private = 1`;
  yield* sql`CREATE TABLE memory_capture_excluded (unit TEXT PRIMARY KEY)`;
});

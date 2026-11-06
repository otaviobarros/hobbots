import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The Attempt a hob's save outside any chat was made in (ADR 028, #1049), so the capture worker tells
// that Attempt's session when a kept save lands, even after a retry moved its Task to a newer Attempt.
// Null for a save made in a chat, and for those recorded before.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_saves ADD COLUMN attempt_id TEXT`;
});

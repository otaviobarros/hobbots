import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// When a thread was archived, or null while it is live. Thread lists leave archived threads out;
// search still finds them. The index lists a hob's archived threads newest-archived first.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN archived_at TEXT`;
  yield* sql`CREATE INDEX threads_agent_archived ON threads (agent_id, archived_at)`;
});

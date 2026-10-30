import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob is active, paused or retired (AG-006). Every hob before this column was active.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`;
});

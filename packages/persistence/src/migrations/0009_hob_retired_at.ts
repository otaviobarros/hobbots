import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// When a hob was retired, shown under Archived hobs (AG-006). Hobs retired before this have no time.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agents ADD COLUMN retired_at TEXT`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The providers the user connected during setup, as a JSON array. Setup could be completed only
// with a ready Claude Code before this column existed, so a completed installation starts with
// Claude Code connected and keeps opening on Home.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE installation_setup ADD COLUMN connected_providers TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`UPDATE installation_setup SET connected_providers = '["claude-code"]' WHERE completed = 1`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The providers the user connected during setup, as a JSON array. Before this column existed,
// Claude Code was the only provider and a completed installation used it implicitly, so a
// completed installation keeps that connection rather than asking again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE installation_setup ADD COLUMN connected_providers TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`UPDATE installation_setup SET connected_providers = '["claude-code"]' WHERE completed = 1`;
});

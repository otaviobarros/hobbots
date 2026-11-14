import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// How many turns run at once (#1448): the limits per hob, per Quest and per runtime, one row the hub
// keeps across restarts. No row means the defaults.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE turn_limits (
    id INTEGER PRIMARY KEY,
    per_hob INTEGER NOT NULL,
    per_quest INTEGER NOT NULL,
    per_runtime TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
});

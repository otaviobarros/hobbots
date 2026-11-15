import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The turn limits per hob, Quest and runtime are gone (#1590): one fixed cap on turns across the hub
// replaces them, and it is not stored.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE turn_limits`;
});

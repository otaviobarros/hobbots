import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The hub reads a repository's taken claims on every write-like tool call (#1449), by repository and
// state alone, which `claims_open` (scope first) cannot serve, so it gets its own index.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX claims_taken ON claims (repository, state)`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A look seed is any unsigned 32-bit value. PostgreSQL INTEGER stops at 2^31 - 1, so it widens
// to BIGINT there; SQLite INTEGER already holds 64 bits and needs no change (ADR 011).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.onDialectOrElse({
    pg: () => sql`ALTER TABLE agents ALTER COLUMN look_seed TYPE BIGINT`,
    orElse: () => Effect.void,
  });
});

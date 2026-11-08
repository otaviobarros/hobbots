import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Whether other hobs see a hob in their directory (ADR 032), stored as 0 or 1. Every existing hob
// and configuration version stays visible.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["agents", "agent_config_versions"]) {
    yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN visible_to_hobs INTEGER NOT NULL DEFAULT 1`;
  }
});

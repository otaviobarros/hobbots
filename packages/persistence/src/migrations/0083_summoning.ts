import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The Summoning Charm (ADR 034). Its scope lives in a hob's policy beside its Charm overrides, kept
// with each configuration version as JSON text, null for the default scope. The Charms you gave every
// hob that you took away from one hob are its withheld Charms, a JSON array, none for every hob so
// far. "Summoning for every hob" is the setup's, as JSON text, null for off, as every hub was before.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["agents", "agent_config_versions"]) {
    yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN summoning_scope TEXT`;
    yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN withheld_charms TEXT NOT NULL DEFAULT '[]'`;
  }
  yield* sql`ALTER TABLE installation_setup ADD COLUMN summoning_every_hob TEXT`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob's tone: one voice and one length. Every existing hob and configuration version gets the
// defaults, Default and Balanced, which add nothing to what the runtime is told, so no hob starts
// talking differently.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["agents", "agent_config_versions"]) {
    const t = sql(table);
    yield* sql`ALTER TABLE ${t} ADD COLUMN voice TEXT NOT NULL DEFAULT 'default'`;
    yield* sql`ALTER TABLE ${t} ADD COLUMN length TEXT NOT NULL DEFAULT 'balanced'`;
  }
});

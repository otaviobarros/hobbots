import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob's own folders, the shared folders it hides and its per-operation overrides (ADR 014), kept
// with each configuration version so a running turn keeps the policy it started with. Each is a
// JSON text column, like the setup's folders. Every existing hob and version gets an empty policy:
// the shared folders and the preset as they are, so no hob gains or loses anything.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["agents", "agent_config_versions"]) {
    const t = sql(table);
    yield* sql`ALTER TABLE ${t} ADD COLUMN own_folders TEXT NOT NULL DEFAULT '[]'`;
    yield* sql`ALTER TABLE ${t} ADD COLUMN hidden_shared_folders TEXT NOT NULL DEFAULT '[]'`;
    yield* sql`ALTER TABLE ${t} ADD COLUMN policy_overrides TEXT NOT NULL DEFAULT '{}'`;
  }
});

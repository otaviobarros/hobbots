import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Whether a hob signs Git commits with the user's 1Password SSH key (ADR 014): 1 or 0, kept with each
// configuration version like the rest of its policy. Every existing hob and version is 0, unsigned.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["agents", "agent_config_versions"]) {
    yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN sign_commits INTEGER NOT NULL DEFAULT 0`;
  }
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob's Charms are a set of Charm ids (ADR 031), kept with each configuration version like the
// rest of its policy, as JSON text. The GitHub Charm flag of migration 0027 becomes that set: on
// holds the GitHub Charm, off holds none. The flag's column goes.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["agents", "agent_config_versions"]) {
    yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN charms TEXT NOT NULL DEFAULT '[]'`;
    yield* sql`UPDATE ${sql(table)} SET charms = ${JSON.stringify(["github"])} WHERE github_charm <> 0`;
    yield* sql`ALTER TABLE ${sql(table)} DROP COLUMN github_charm`;
  }
});

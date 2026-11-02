import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The GitHub Charm (ADR 020). Whether a hob has the Charm, 1 or 0, kept with each configuration
// version like the rest of its policy; every existing hob and version is 1, so the reads they had
// keep working. And the GitHub account the hub connected, in one row at most: which sign-in it
// uses, its login and when, never a token: the app's live in the OS keychain, and the others are
// read where the user keeps them for each call.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["agents", "agent_config_versions"]) {
    yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN github_charm INTEGER NOT NULL DEFAULT 1`;
  }
  yield* sql`
    CREATE TABLE github_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source TEXT NOT NULL,
      login TEXT NOT NULL,
      connected_at TEXT NOT NULL
    )
  `;
});

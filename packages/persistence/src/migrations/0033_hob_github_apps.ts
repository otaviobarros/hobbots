import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Each hob's own GitHub App (ADR 022): one row per hob at most, with the app's identity and its bot's
// user ID, never a secret. Its private key lives in the OS keychain on the hub; GitHub's client and
// webhook secrets are dropped as soon as the app is made. GitHub's IDs are 64-bit on PostgreSQL
// (BIGINT); SQLite's INTEGER already holds 64 bits. `left_over` holds what the hub could not remove
// when the app was disconnected or its hob retired; such an app no longer acts, and stays shown until
// the user dismisses it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE hob_github_apps (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      app_id BIGINT NOT NULL,
      client_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      owner TEXT NOT NULL,
      bot_user_id BIGINT,
      html_url TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      left_over TEXT
    )
  `;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// One row holds the installation's setup. An installation that already has hobs was set up
// before this table existed, so it starts completed and keeps opening on Home.
// `completed` is 0 or 1: SQLite has no BOOLEAN type, so both databases store an INTEGER (ADR 011).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE installation_setup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        completed INTEGER NOT NULL,
        safety_preset TEXT NOT NULL,
        approved_folders TEXT NOT NULL
      )
    `;
  yield* sql`
      INSERT INTO installation_setup (id, completed, safety_preset, approved_folders)
      SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM agents) THEN 1 ELSE 0 END, 'balanced', '[]'
    `;
});

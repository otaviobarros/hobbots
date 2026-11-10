import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Whether a hob's own GitHub App was made by the hub from a manifest (`made`) or is one the user
// already had and linked (`linked`, #1321). Disconnecting a linked app only forgets its key; it never
// removes the app's installations. Every app kept before was made.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE hob_github_apps ADD COLUMN origin TEXT NOT NULL DEFAULT 'made'`;
});

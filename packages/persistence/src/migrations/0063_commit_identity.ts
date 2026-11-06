import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Who hobs on the user's account commit as when the user's own Git config sets no identity (#741):
// the name and email the user gave the hub when it asked, in one row at most, and when.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE commit_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      set_at TEXT NOT NULL
    )
  `;
});

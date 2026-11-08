import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Where the user said not to ask whether a hob will write code (#1241): a hob's id, or `*` for
// every hob, and when.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE coding_setup_dismissals (
      scope TEXT PRIMARY KEY,
      dismissed_at TEXT NOT NULL
    )
  `;
});

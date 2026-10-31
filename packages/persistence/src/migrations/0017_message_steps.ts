import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A reply's steps (thinking and tool calls) as JSON text, saved with the reply so they replay on
// reconnect and stay once it ends. Every existing message has none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'`;
});

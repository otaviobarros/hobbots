import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The read-the-web mark of an Attempt's session (ADR 036, #1268): when it first searched or read a
// page, and the page or search it read last, or null while it read nothing. No session was marked
// before this.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE attempts ADD COLUMN read_web_since TEXT`;
  yield* sql`ALTER TABLE attempts ADD COLUMN read_web_source TEXT`;
});

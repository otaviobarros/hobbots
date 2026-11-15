import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob's reply keeps the read-the-web mark its session held while it wrote it (ADR 036, ADR 039, A
// relay carries the read-the-web mark), so a turn whose context holds the reply starts marked, in any
// chapter and on any session. `read_web` is the mark as JSON, `{since, source}`; every reply stored
// before this reads as unmarked, as its session's own mark still covers that session.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN read_web TEXT`;
});

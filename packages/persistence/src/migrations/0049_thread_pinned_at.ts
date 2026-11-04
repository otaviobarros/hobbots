import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// When a thread was pinned to the top of its hob's chats, or null when it is not pinned (#501).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN pinned_at TEXT`;
});

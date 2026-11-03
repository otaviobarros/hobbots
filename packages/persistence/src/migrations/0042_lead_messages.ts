import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A lead's message to a member's Task (#574) is kept as a note on that Task, sent by the lead to
// the Task's owner. `sender_id` names the hob that sent it; null is a note you left, as before.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE task_notes ADD COLUMN sender_id TEXT`;
});

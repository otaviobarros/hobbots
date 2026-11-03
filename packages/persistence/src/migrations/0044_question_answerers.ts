import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Where you answered a question (#671), as approvals record their decider (#598): the approved
// device you answered from, and where, `chat`, `inbox` or `task`. Questions answered before this,
// and those a lead answered, have neither.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE questions ADD COLUMN answered_by_device_id TEXT`;
  yield* sql`ALTER TABLE questions ADD COLUMN answered_via TEXT`;
});

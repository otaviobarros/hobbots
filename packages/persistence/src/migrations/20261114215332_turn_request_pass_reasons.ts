import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob that has nothing to add passes (ADR 039, One hob speaks at a time; #1462): its request ends
// `passed`, a state the table already allows, and keeps the hob's reason here. Every request stored
// before this was never passed, so each reads as having no reason.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE turn_requests ADD COLUMN pass_reason TEXT`;
});

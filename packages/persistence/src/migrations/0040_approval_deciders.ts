import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Who decided an approval request (#598): the approved device the user decided it from, and where,
// `chat` or `inbox`, or `expired` when nobody did. Several devices can decide once remote access is
// on, so a decision names its own. Requests closed before this have neither.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN decided_by_device_id TEXT`;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN decided_via TEXT`;
});

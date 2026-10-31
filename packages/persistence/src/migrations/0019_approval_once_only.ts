import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Whether an approval request is for a high-risk action, approved once only and with the user's
// confirmation (PE-007): 1 or 0. Requests stored before this are 0.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN once_only INTEGER NOT NULL DEFAULT 0`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Why the policy asked, as its code (ADR 036, #1271), so an approval card can say a page is on a new
// site, on your local network or at an address the hob wrote. Requests from before have none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN reason_code TEXT`;
});

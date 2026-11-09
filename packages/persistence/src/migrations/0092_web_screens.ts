import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The web search screens (ADR 036, #1271). Why the policy asked, as its code, so an approval card can
// say a page is on a new site, on your local network or at an address the hob wrote; requests from
// before have none. And the step each page read shows as, so a reply finds each read's text by its
// call; pages read before have none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN reason_code TEXT`;
  yield* sql`ALTER TABLE web_fetches ADD COLUMN step_id TEXT`;
});

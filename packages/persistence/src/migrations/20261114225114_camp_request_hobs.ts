import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A camp is made with the hobs picked (#1467, ADR 039). `camp_requests` keeps them too, as a JSON list
// of the hobs other than the lead, sorted and each once, so the same key asked again with other hobs is
// a reused key, not a retry. A request from before has none, which reads as no other hobs.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE camp_requests ADD COLUMN hobs TEXT`;
});

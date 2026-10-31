import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// When the provider's allowance refills, for a reply its usage limit ended (ISO 8601). Null for
// every other message, including all existing ones.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN resets_at TEXT`;
});

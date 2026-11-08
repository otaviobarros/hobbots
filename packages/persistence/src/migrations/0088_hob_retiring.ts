import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob finishing its open Tasks before it retires (#408): since when and who asked, as JSON text,
// or null. No hob was waiting to retire before this.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agents ADD COLUMN retiring TEXT`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The choices a question offers (#740): JSON text, a list of { label, consequence }, empty for a
// question answered in words only and for every question asked before this. `recommended` is the
// index of the choice its asker recommends, and `picked` the index of the one its answer picked;
// both null when there is none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE questions ADD COLUMN options TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE questions ADD COLUMN recommended INTEGER`;
  yield* sql`ALTER TABLE questions ADD COLUMN picked INTEGER`;
});

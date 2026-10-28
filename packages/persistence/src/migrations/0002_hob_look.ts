import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Every hob keeps the seed and color of its generated avatar, so it looks the same everywhere.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agents ADD COLUMN look_seed INTEGER NOT NULL DEFAULT 4821`;
  yield* sql`ALTER TABLE agents ADD COLUMN look_color TEXT NOT NULL DEFAULT 'violet'`;
});

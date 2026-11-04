import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A checkpoint's summary is a short beat a lane shows; what its owner had to say beyond that goes in
// its detail, which the Workbench shows (#901). Null for a checkpoint with none, and for every one
// recorded before this.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE checkpoints ADD COLUMN detail TEXT`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Where a path claim was made (#1578): the real path of the top folder of the checkout the hob
// claimed in. When you take the claim over, every hob's sandbox closes the path in that checkout
// and in each worktree Git lists for it, so no turn walks its folders to find the repository's
// copies. A claim made before this has no checkout, and its path is closed by the call-level check
// alone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE claims ADD COLUMN checkout TEXT`;
});

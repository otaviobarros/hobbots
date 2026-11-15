import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Where a path claim's repository keeps its Git folder (#1578): the real path of the Git folder
// every checkout of it shares, the main repository's own. When you take the claim over, every hob's
// sandbox closes the path in each worktree Git lists there, the main one and each linked one still
// on disk, so no turn walks its folders to find the repository's copies, and removing the worktree
// it was claimed in leaves the others closed. A claim made before this has none, and its path is
// closed by the call-level check alone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE claims ADD COLUMN git_folder TEXT`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What reading `~/.agents/skills` again after a restore moved (ADR 029). A backup holds no file of
// those skills, so an assignment pinned to a revision the folder no longer has moves to the folder's
// current one, and the restore's summary says so. `skill_moves` is JSON: each move's skill name and
// scope, oldest first. Empty for restores from before.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE restores ADD COLUMN skill_moves TEXT NOT NULL DEFAULT '[]'`;
});

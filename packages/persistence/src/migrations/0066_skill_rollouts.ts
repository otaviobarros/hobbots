import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// When a revision was rolled out to every assignment of its skill that is not held (ADR 029, Pins and
// rollout), or null while that has not finished. Saving the same content again finishes a rollout the
// hub stopped in the middle of, and a source that still holds the revision never rolls it out again,
// so a rollback stays. Revisions recorded before count as rolled out.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE skill_revisions ADD COLUMN rolled_out_at TEXT`;
  yield* sql`UPDATE skill_revisions SET rolled_out_at = added_at`;
});

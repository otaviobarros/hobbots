import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A checkpoint can be about a second Task as well as its own (#570): a finding the hub records when
// two Tasks of the same work change the same file names the Task that changed it first, so both
// Tasks show it. Null for every other checkpoint, including all recorded before this.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE checkpoints ADD COLUMN about_task_id TEXT REFERENCES tasks(id)`;
});

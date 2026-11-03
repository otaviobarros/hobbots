import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Who asked for a Task's cancel (#669, #674), so an Attempt it stops can say so: `requested_by`
// names the hob that cancelled it, and null is a cancel you asked for. A Task cancelled with its
// parent has no row of its own; its nearest cancelled ancestor's says who. Cancels from before
// this have none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE task_cancels (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    requested_by TEXT,
    requested_at TEXT NOT NULL
  )`;
});

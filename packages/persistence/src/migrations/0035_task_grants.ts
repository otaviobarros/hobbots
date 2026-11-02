import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// This Task (ADR 018) binds a grant to the top Task of the request's tree, not to a Quest: a Task
// that a party joins keeps its id. No grant was ever bound to a Quest, so `quest_id`, always null,
// becomes `task_id`. A request records the top Task it was asked in, which This Task binds to;
// requests from before this have none, and offer no This Task.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE grants RENAME COLUMN quest_id TO task_id`;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN root_task_id TEXT REFERENCES tasks(id)`;
  yield* sql`CREATE INDEX grants_task ON grants (task_id, revoked_at)`;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The supervisor's record of each Task it acted on (#1447): where it stands, the retries it made
// itself, the refused calls already reported and the Attempt it last acted on, so its rules act once
// on each fact and a retry budget holds across restarts. Read by the Task's tree.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE task_supervision (
    task_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    state TEXT NOT NULL,
    retries INTEGER NOT NULL,
    refusals_seen INTEGER NOT NULL,
    attempt_id TEXT,
    rule TEXT,
    reason TEXT,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX task_supervision_root ON task_supervision (root_id)`;
});

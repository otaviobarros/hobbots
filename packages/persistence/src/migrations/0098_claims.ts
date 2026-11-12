import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The claims register (ADR 037): a hob's claim on the next number in a folder, a path or a branch,
// held by a Task until the Task ends. A number is unique in its folder of a repository for good,
// released or not, so it is never handed out twice; a path or branch is open once per Task, since two Tasks
// may claim the same one and each contests the other, and a retried Task may claim it again once released.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE claims (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    repository TEXT NOT NULL,
    directory TEXT,
    claim_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT,
    revision BIGINT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX claims_numbers ON claims (repository, directory, claim_key)
    WHERE directory IS NOT NULL`;
  yield* sql`CREATE UNIQUE INDEX claims_names ON claims (scope, repository, claim_key, task_id)
    WHERE directory IS NULL AND state <> 'released'`;
  yield* sql`CREATE INDEX claims_by_task ON claims (task_id)`;
  yield* sql`CREATE INDEX claims_open ON claims (scope, repository, state)`;
});

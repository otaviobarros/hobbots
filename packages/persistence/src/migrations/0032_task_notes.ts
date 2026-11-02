import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Notes you leave on a Task (ADR 018). Each goes to the Task's nearest lead as a message about that
// Task, so the note keeps who it went to. Its id is the idempotency key of the command that left
// it: leaving the same note again finds this row and changes nothing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE task_notes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        recipient_id TEXT NOT NULL REFERENCES agents(id),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0
      )
    `;
  yield* sql`CREATE INDEX task_notes_task ON task_notes (task_id)`;
});

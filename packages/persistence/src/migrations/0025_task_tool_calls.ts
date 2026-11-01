import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Hob tools for Tasks and Quests (ADR 018). `task_tool_calls` keeps the result of each call a hob
// made, keyed by the hob and the key it sent, so a retried call returns the first result and never
// writes twice. `input` is the call's input as stable JSON without its key and with the Task the
// turn worked on, so a key sent again with another call, or from another Task, is told apart. `result` is the stored result as JSON text.
//
// `task_waits` holds what a Task's owner waits for: the Tasks under it (`waits_on`, JSON text)
// and whether any or all of them must end. A Task has at most one wait; a new one replaces it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE task_tool_calls (
        agent_id TEXT NOT NULL REFERENCES agents(id),
        call_key TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, call_key)
      )
    `;
  yield* sql`
      CREATE TABLE task_waits (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        waits_on TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
});

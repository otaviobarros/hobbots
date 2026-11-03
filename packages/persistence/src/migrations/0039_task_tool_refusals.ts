import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Refused Task tool calls (ADR 018, #575). `task_tool_calls` keeps only calls that were done, so a
// refused call's key stays free for a retry that is decided again; each refusal is recorded here
// instead, so the user and an audit can see it. A call retried with its key and refused again is
// the same row, with `tries` counted up and the latest refusal; a call that came with no usable
// key, such as one whose input did not decode, has a NULL `call_key` and a row of its own.
// `task_id` is the Task the calling turn worked on, when the hub knew it, and is not a foreign key:
// a call can be refused for naming a Task that does not exist. `input` is stable JSON, cut when long.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE task_tool_refusals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      call_key TEXT,
      task_id TEXT,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      reason TEXT NOT NULL,
      message TEXT NOT NULL,
      tries INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      refused_at TEXT NOT NULL,
      UNIQUE (agent_id, call_key)
    )
  `;
  yield* sql`CREATE INDEX task_tool_refusals_task ON task_tool_refusals (task_id)`;
});

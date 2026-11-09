import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Hob proposals (ADR 034, Asking is a proposal): a Summoning Charm call that asks is recorded here on
// the manager's call, and waits for you in the Inbox and on the call's step. `scope` and `call_key`
// name the call behind it, as `charm_calls` does, and move with it into its Task's work. `rows` is
// the JSON of each hob's row and how you decided it, `asks` and `always_allowed` the operations
// "Always allow" may set and those you set, both JSON. `revision` grows on every change, which is
// one conditional update on it, so of two decisions racing for one proposal only the first lands.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE hob_proposals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      kind TEXT NOT NULL,
      tool TEXT NOT NULL,
      scope TEXT NOT NULL,
      call_key TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      task_id TEXT,
      step_id TEXT,
      rows TEXT NOT NULL,
      asks TEXT NOT NULL,
      safety TEXT,
      high_risk INTEGER NOT NULL CONSTRAINT hob_proposals_high_risk_flag CHECK (high_risk IN (0, 1)),
      always_allowed TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT
    )
  `;
  yield* sql`CREATE UNIQUE INDEX hob_proposals_call ON hob_proposals (agent_id, scope, call_key)`;
  yield* sql`CREATE INDEX hob_proposals_state ON hob_proposals (state, created_at)`;
});

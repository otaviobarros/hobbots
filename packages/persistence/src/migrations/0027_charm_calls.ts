import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Charm call records (ADR 020). Every Charm write, such as a GitHub push, is recorded with the key
// the hob sent before anything is sent, so a retried call returns the first result and is never sent
// twice. `input` is the call's input as stable JSON without its key. `site` names where it acts, so
// two writes of the same tool on one site never overlap while one is uncertain. `plan` is what the hub
// fixed when it decided, as JSON text. The thread, message and step are the reply step the call
// showed as, so the user can settle an uncertain call there.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE charm_calls (
        agent_id TEXT NOT NULL REFERENCES agents(id),
        call_key TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        site TEXT NOT NULL,
        plan TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        thread_id TEXT,
        message_id TEXT,
        step_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, call_key)
      )
    `;
  yield* sql`CREATE INDEX charm_calls_site ON charm_calls (tool, site, state)`;
  yield* sql`CREATE INDEX charm_calls_step ON charm_calls (thread_id, message_id, step_id)`;
});

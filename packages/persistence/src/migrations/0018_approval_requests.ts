import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Tool calls the policy answered Ask for, each waiting for the user's decision or already decided
// (PE-003). A request names the requesting hob, the exact action (operation, targets and the call's
// concrete arguments as JSON text, with their digest) and the policy version it was asked under.
// `state` is pending, approved, denied or expired; only a pending request can be decided.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        thread_id TEXT NOT NULL REFERENCES threads(id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        step_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        operation TEXT NOT NULL,
        targets TEXT NOT NULL,
        arguments TEXT NOT NULL,
        label TEXT NOT NULL,
        reason TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        state TEXT NOT NULL,
        deny_reason TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        revision BIGINT NOT NULL DEFAULT 0
      )
    `;
  yield* sql`CREATE INDEX approval_requests_thread ON approval_requests (thread_id, created_at)`;
  yield* sql`CREATE INDEX approval_requests_state ON approval_requests (state)`;
});

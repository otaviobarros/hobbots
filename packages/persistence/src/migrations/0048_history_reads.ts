import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob's History reads its own approval requests, the Tasks its leads gave it and the Tasks it gave
// its party (ADR 018). These indexes let that read find them by hob instead of scanning every row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX approval_requests_agent ON approval_requests (agent_id)`;
  yield* sql`CREATE INDEX delegations_lead ON delegations (lead_id)`;
  yield* sql`CREATE INDEX delegations_member ON delegations (member_id)`;
});

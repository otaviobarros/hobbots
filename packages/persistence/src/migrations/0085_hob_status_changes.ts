import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Each pause, wake, retirement and return of a hob, with who made it (ADR 034), so a hob's History
// and the Changes log keep them after the journal is compacted. Configuration versions already keep
// their actor (0082). Nothing was recorded before, so the table starts empty.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE agent_status_changes (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      revision BIGINT NOT NULL,
      from_status TEXT NOT NULL,
      status TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, revision)
    )
  `;
});

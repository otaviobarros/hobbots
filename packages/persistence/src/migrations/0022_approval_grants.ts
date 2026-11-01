import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Standing grants (ADR 015, PE-007): a decision with the lifetime This Quest or Always saves a rule
// for one hob, one operation and one site. `rule` is the rule as JSON text, as the user saw it. A
// grant is never deleted: it is revoked, with who revoked it, when and why, so History keeps it.
// `quest_id` and `expires_at` are null until Quests and time-boxed lifetimes exist.
//
// Approval requests gain whether a grant could answer them (`grantable`, 0 or 1), the rules Always
// would save (JSON text), the lifetime they were approved with, and when they expire undecided.
// Requests stored before this offer once only and have no expiry of their own.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        operation TEXT NOT NULL,
        rule TEXT NOT NULL,
        lifetime TEXT NOT NULL,
        quest_id TEXT,
        approval_id TEXT REFERENCES approval_requests(id),
        granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT,
        revoked_by TEXT,
        revoke_reason TEXT,
        revision BIGINT NOT NULL DEFAULT 0
      )
    `;
  yield* sql`CREATE INDEX grants_agent ON grants (agent_id, revoked_at)`;
  yield* sql`CREATE INDEX grants_approval ON grants (approval_id)`;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN grantable INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN rules TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN lifetime TEXT`;
  yield* sql`ALTER TABLE approval_requests ADD COLUMN expires_at TEXT`;
});

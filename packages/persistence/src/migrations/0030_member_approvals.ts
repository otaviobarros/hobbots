import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A party member's turn runs outside the chat (ADR 018), so its approval requests have no reply to
// pause: `message_id` becomes nullable, and `task_id` names the member's Task the turn works on.
// Requests stored before this belong to chat turns and keep their reply; their Task is null.
//
// SQLite cannot drop NOT NULL, so it rebuilds the table. With foreign keys on, renaming a table
// rewrites the references to it, and dropping one checks its children, so `grants`, which points at
// `approval_requests`, is moved aside first and rebuilt after it, in this migration's transaction.
const APPROVAL_COLUMNS = `id, agent_id, thread_id, message_id, step_id, tool, operation, targets, arguments, label,
  reason, action_digest, policy_version, state, deny_reason, created_at, decided_at, revision, once_only, grantable,
  rules, lifetime, expires_at`;
const GRANT_COLUMNS = `id, agent_id, operation, rule, lifetime, quest_id, approval_id, granted_by, created_at,
  expires_at, last_used_at, revoked_at, revoked_by, revoke_reason, revision`;

const sqlite = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DROP INDEX grants_agent`;
    yield* sql`DROP INDEX grants_approval`;
    yield* sql`DROP INDEX approval_requests_thread`;
    yield* sql`DROP INDEX approval_requests_state`;
    yield* sql`ALTER TABLE grants RENAME TO grants_before_0030`;
    yield* sql`ALTER TABLE approval_requests RENAME TO approval_requests_before_0030`;
    yield* sql`
      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        thread_id TEXT NOT NULL REFERENCES threads(id),
        message_id TEXT REFERENCES messages(id),
        task_id TEXT REFERENCES tasks(id),
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
        revision BIGINT NOT NULL DEFAULT 0,
        once_only INTEGER NOT NULL DEFAULT 0,
        grantable INTEGER NOT NULL DEFAULT 0,
        rules TEXT NOT NULL DEFAULT '[]',
        lifetime TEXT,
        expires_at TEXT
      )
    `;
    yield* sql.unsafe(
      `INSERT INTO approval_requests (${APPROVAL_COLUMNS}) SELECT ${APPROVAL_COLUMNS} FROM approval_requests_before_0030`,
    );
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
    yield* sql.unsafe(`INSERT INTO grants (${GRANT_COLUMNS}) SELECT ${GRANT_COLUMNS} FROM grants_before_0030`);
    yield* sql`DROP TABLE grants_before_0030`;
    yield* sql`DROP TABLE approval_requests_before_0030`;
  });

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        yield* sql`ALTER TABLE approval_requests ALTER COLUMN message_id DROP NOT NULL`;
        yield* sql`ALTER TABLE approval_requests ADD COLUMN task_id TEXT REFERENCES tasks(id)`;
      }),
    orElse: () => sqlite(sql),
  });
  yield* sql`CREATE INDEX IF NOT EXISTS approval_requests_thread ON approval_requests (thread_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS approval_requests_state ON approval_requests (state)`;
  yield* sql`CREATE INDEX IF NOT EXISTS approval_requests_task ON approval_requests (task_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS grants_agent ON grants (agent_id, revoked_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS grants_approval ON grants (approval_id)`;
});

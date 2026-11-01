import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A thread can switch brains (ADR 017):
// - threads keep one session per runtime as JSON text, and their own brain (JSON, null to follow the
//   hob). Each existing thread's Claude Code session moves into its sessions, seen through its
//   latest message, since it has seen the whole thread.
// - a hob's runtime is versioned with its configuration; every version so far ran on Claude Code.
// - each assistant reply records the runtime and model it ran on; existing replies ran on Claude
//   Code with their configuration version's model.
// - a thread's summary of older messages is stored once and reused by the next handoff.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN sessions TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE threads ADD COLUMN brain TEXT`;
  const bound = yield* sql<{ id: string; runtimeSessionId: string; latest: string | null }>`
    SELECT id, runtime_session_id,
      (SELECT m.id FROM messages m WHERE m.thread_id = threads.id AND m.status <> 'queued'
        ORDER BY m.seq DESC LIMIT 1) AS latest
    FROM threads WHERE runtime_session_id IS NOT NULL`;
  for (const thread of bound) {
    const sessions = [{ runtime: "claude-code", sessionId: thread.runtimeSessionId, seenThrough: thread.latest }];
    yield* sql`UPDATE threads SET sessions = ${JSON.stringify(sessions)} WHERE id = ${thread.id}`;
  }
  yield* sql`ALTER TABLE threads DROP COLUMN runtime_session_id`;

  yield* sql`ALTER TABLE agent_config_versions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude-code'`;

  yield* sql`ALTER TABLE messages ADD COLUMN runtime TEXT`;
  yield* sql`ALTER TABLE messages ADD COLUMN model TEXT`;
  yield* sql`UPDATE messages SET
      runtime = 'claude-code',
      model = (
        SELECT v.model FROM agent_config_versions v JOIN threads t ON t.agent_id = v.agent_id
        WHERE t.id = messages.thread_id AND v.version = messages.config_version
      )
    WHERE role = 'assistant'`;

  yield* sql`
      CREATE TABLE thread_checkpoints (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id),
        through_message_id TEXT NOT NULL,
        lines TEXT NOT NULL,
        omitted INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
});

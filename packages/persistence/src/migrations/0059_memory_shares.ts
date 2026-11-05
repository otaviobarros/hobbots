import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Memory shares (ADR 028, Sharing). Every `memory_save` that asks to share a page with a project or
// with every hob is recorded and journaled before anything is written, keyed as a hob's own saves are
// (migration 0055): by hob, work and the SHA-256 of its key, with the SHA-256 of its input beside it.
// `memory_scope` is the shared memory it is for, as JSON. `pending` says what is being written while
// the share is `sending` (sharing it, keeping it private or undoing it), recorded before memory is
// touched so the hub can find out afterwards what landed. `through` says whether your review or the
// preset let it through, `version` and `previous` the version it wrote and the one it replaced, which
// Undo brings back, and `edited` (0 or 1) whether you changed the page before you shared it. The
// markdown and tags are redacted before they are recorded, or are as you edited them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE memory_shares (
        id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        scope TEXT NOT NULL,
        call_key TEXT NOT NULL,
        input TEXT NOT NULL,
        memory_scope TEXT NOT NULL,
        path TEXT NOT NULL,
        markdown TEXT NOT NULL,
        tags TEXT NOT NULL,
        state TEXT NOT NULL CONSTRAINT memory_shares_state_known CHECK (state IN ('sending', 'waiting', 'shared', 'kept', 'undone')),
        pending TEXT CONSTRAINT memory_shares_pending_known CHECK (pending IN ('share', 'keep', 'undo')),
        through TEXT NOT NULL CONSTRAINT memory_shares_through_known CHECK (through IN ('review', 'preset')),
        edited INTEGER NOT NULL CONSTRAINT memory_shares_edited_flag CHECK (edited IN (0, 1)),
        version TEXT,
        previous TEXT,
        thread_id TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        CONSTRAINT memory_shares_pending_while_sending CHECK ((state = 'sending') = (pending IS NOT NULL)),
        CONSTRAINT memory_shares_key PRIMARY KEY (agent_id, scope, call_key)
      )
    `;
  yield* sql`CREATE INDEX memory_shares_state ON memory_shares (state, updated_at)`;
});

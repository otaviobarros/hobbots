import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob's backpack (ADR 019). `backpack_items` is also the outbox: an item is committed with the
// change that caused it, before anything delivers it. `dedupe_key` is unique per recipient, so the
// same change or tool call recorded again adds nothing. `actionable` is 1 or 0; `payload` and
// `disposition` are JSON text, times ISO 8601 text, as elsewhere. `recorded_sequence` is the journal
// sequence the item was recorded at; unlike `revision`, it never changes, so reads keep that order.
//
// The claim lives on the item: `claim_owner` and `lease_expires_at` while a worker holds it, and
// `claim_token`, the fencing token, which only grows. Every write under a claim checks all three
// in one conditional update. `backpack_deliveries` keeps every time the item was put into a turn,
// with the claim it was delivered under and the runtime's acknowledgement of that turn.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE backpack_items (
        id TEXT PRIMARY KEY,
        recipient_id TEXT NOT NULL REFERENCES agents(id),
        kind TEXT NOT NULL,
        actionable INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        state TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        quest_id TEXT REFERENCES quests(id),
        attempt_id TEXT REFERENCES attempts(id),
        thread_id TEXT REFERENCES threads(id),
        dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        not_before TEXT,
        claim_owner TEXT,
        claim_token BIGINT NOT NULL DEFAULT 0,
        lease_expires_at TEXT,
        disposition TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0,
        recorded_sequence BIGINT NOT NULL,
        UNIQUE (recipient_id, dedupe_key)
      )
    `;
  yield* sql`CREATE INDEX backpack_items_recipient ON backpack_items (recipient_id, state)`;
  yield* sql`CREATE INDEX backpack_items_quest ON backpack_items (quest_id, state)`;
  yield* sql`CREATE INDEX backpack_items_state ON backpack_items (state)`;
  yield* sql`
      CREATE TABLE backpack_deliveries (
        item_id TEXT NOT NULL REFERENCES backpack_items(id),
        number INTEGER NOT NULL,
        claim_token BIGINT NOT NULL,
        target TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        acknowledged_session_id TEXT,
        acknowledged_at TEXT,
        PRIMARY KEY (item_id, number)
      )
    `;
});

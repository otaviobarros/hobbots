import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Blockers (IN-007, ADR 019): every time a backpack item failed, why, the next action it suggests,
// and what you chose. `after_deliveries` is how many deliveries the item had used when it failed,
// so a retry counts its fresh ones from there. `decision` is null while the blocker waits for you.
// An item that failed before this migration gets the blocker it would have had.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE backpack_blockers (
        item_id TEXT NOT NULL REFERENCES backpack_items(id),
        number INTEGER NOT NULL,
        reason TEXT NOT NULL,
        next_action TEXT NOT NULL,
        error TEXT NOT NULL,
        after_deliveries INTEGER NOT NULL,
        raised_at TEXT NOT NULL,
        decision TEXT,
        decided_at TEXT,
        PRIMARY KEY (item_id, number)
      )
    `;
  yield* sql`
      INSERT INTO backpack_blockers (item_id, number, reason, next_action, error, after_deliveries, raised_at)
      SELECT id, 1, 'retries-exhausted', 'retry', COALESCE(error, 'Failed.'),
        (SELECT COUNT(*) FROM backpack_deliveries WHERE item_id = backpack_items.id), updated_at
      FROM backpack_items WHERE state = 'failed'
    `;
});

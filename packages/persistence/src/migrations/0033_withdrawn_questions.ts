import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql";

// A question whose Task ended as cancelled or failed before anyone answered it is withdrawn: nobody
// is left to hear its answer. Questions left open by Tasks that ended before this rule existed are
// withdrawn here, so they stop holding their lead's ledger open, and their copies still pending and
// unclaimed in a lead's backpack resolve as late at the version their Task ended at, as the hub
// resolves them when a Task ends now, so no lead is woken to answer them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(yield* DateTime.now);
  const ended = sql`SELECT id FROM tasks WHERE state IN ('cancelled', 'failed')`;
  yield* sql`UPDATE questions SET state = 'withdrawn' WHERE state = 'open' AND task_id IN (${ended})`;
  yield* sql`
      UPDATE backpack_items
      SET state = 'resolved', updated_at = ${at},
        disposition = '{"_tag":"late","taskRevision":'
          || CAST((SELECT revision FROM tasks WHERE tasks.id = backpack_items.task_id) AS TEXT) || '}'
      WHERE kind = 'question' AND state = 'pending' AND claim_owner IS NULL AND task_id IN (${ended})
    `;
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A question whose Task ended as cancelled or failed before anyone answered it is withdrawn: nobody
// is left to hear its answer. Questions left open by Tasks that ended before this rule existed are
// withdrawn here, so they stop holding their lead's ledger open.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE questions SET state = 'withdrawn'
      WHERE state = 'open' AND task_id IN (SELECT id FROM tasks WHERE state IN ('cancelled', 'failed'))
    `;
});

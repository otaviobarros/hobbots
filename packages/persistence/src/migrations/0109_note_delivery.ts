import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// How a lead's note asks to reach its member's turn that runs as it arrives (#1345): with the next
// turn, at the running turn's next step between two tool calls, or by stopping that turn and starting
// the next one with the note first. Notes left before this, and yours, wait for the next turn.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE task_notes ADD COLUMN delivery TEXT NOT NULL DEFAULT 'next-turn'`;
});

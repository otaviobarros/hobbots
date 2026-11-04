import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Where a note you send to a lead goes next (#900). `message_id` is the chat message of yours a
// lead's note traces back to, and `from_note_id` the note a nested lead passed on. `picked_up_by`
// and `picked_up_at` name the recipient's turn that last picked the note up (its reply or Attempt
// id) and when, as the backpack delivered it. A pick-up changes the note's `revision`, so
// `left_revision` keeps the order the notes were left in. A reply's `prompt_id` is the message of
// yours its turn answers, null for a continuation and for every reply before this.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE task_notes ADD COLUMN message_id TEXT`;
  yield* sql`ALTER TABLE task_notes ADD COLUMN from_note_id TEXT`;
  yield* sql`ALTER TABLE task_notes ADD COLUMN picked_up_by TEXT`;
  yield* sql`ALTER TABLE task_notes ADD COLUMN picked_up_at TEXT`;
  yield* sql`ALTER TABLE task_notes ADD COLUMN left_revision BIGINT`;
  yield* sql`UPDATE task_notes SET left_revision = revision`;
  yield* sql`CREATE INDEX task_notes_message ON task_notes (message_id)`;
  yield* sql`ALTER TABLE messages ADD COLUMN prompt_id TEXT`;
});

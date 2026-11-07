import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A milestone records the hob whose work reached it (#743): the Task's owner that reported it, or the
// hob it named, such as its lead making a commit the owner could not. Null while it is not reached.
// A milestone reached before this was reported by its Task's owner, so it is credited to that owner.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE milestones ADD COLUMN reached_by TEXT REFERENCES agents(id)`;
  yield* sql`
    UPDATE milestones SET reached_by = (SELECT owner_id FROM tasks WHERE tasks.id = milestones.task_id)
    WHERE reached_at IS NOT NULL
  `;
});

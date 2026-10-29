import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob's craft is what it is good at; the first build called it a role. Effort joins the model as
// the rest of the hob's brain; NULL means the model's default, as a NULL model means the runtime's.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agents RENAME COLUMN role TO craft`;
  yield* sql`ALTER TABLE agents ADD COLUMN effort TEXT`;
});

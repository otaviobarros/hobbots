import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob can be renamed from its profile (#534), so its name is kept with each configuration
// version like the rest of what it is told on every turn. Every existing version takes the name
// its hob has now, which is the only name it ever had.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_config_versions ADD COLUMN name TEXT NOT NULL DEFAULT ''`;
  yield* sql`UPDATE agent_config_versions
    SET name = (SELECT agents.name FROM agents WHERE agents.id = agent_config_versions.agent_id)`;
});

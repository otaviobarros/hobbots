import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Skill sets (ADR 029, Skill sets). A set is a skill whose revision holds several skills that share
// files: `set_skills` is the JSON list of those skills (name, description, folder, Charms), and null
// for a skill. A hob can turn off one skill of a set (`skill_name`) without turning off the set. A
// use of a skill of a set names the set (`set_name`), whose revision `pin` is.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE skill_revisions ADD COLUMN set_skills TEXT`;
  yield* sql`ALTER TABLE skill_uses ADD COLUMN set_name TEXT`;
  yield* sql`
    CREATE TABLE skill_set_opt_outs (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
      skill_name TEXT NOT NULL,
      opted_out_at TEXT NOT NULL,
      CONSTRAINT skill_set_opt_outs_key PRIMARY KEY (agent_id, skill_id, skill_name)
    )
  `;
});

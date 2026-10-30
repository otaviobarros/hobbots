import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob's free-text craft becomes a role: a starter role or a title in the user's own words, with a
// sigil and the hat and tool its sprite wears. The crafts the first picker offered move to their
// starter role; any other craft stays as a custom title with the Assistant sigil. Hat and tool stay
// empty, so every existing hob keeps the look its seed drew. Old configuration versions move the same way.
const crafts = [
  ["Helper", "assistant", "Assistant"],
  ["Scribe", "writer", "Writer"],
  ["Coder", "engineer", "Software engineer"],
  ["Researcher", "researcher", "Researcher"],
  ["Bookkeeper", "bookkeeper", "Bookkeeper"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["agents", "agent_config_versions"]) {
    const t = sql(table);
    yield* sql`ALTER TABLE ${t} RENAME COLUMN craft TO role_title`;
    yield* sql`ALTER TABLE ${t} ADD COLUMN role TEXT`;
    yield* sql`ALTER TABLE ${t} ADD COLUMN sigil TEXT NOT NULL DEFAULT 'assistant'`;
    yield* sql`ALTER TABLE ${t} ADD COLUMN hat TEXT`;
    yield* sql`ALTER TABLE ${t} ADD COLUMN tool TEXT`;
    for (const [craft, role, title] of crafts) {
      yield* sql`UPDATE ${t} SET role = ${role}, role_title = ${title}, sigil = ${role} WHERE role_title = ${craft}`;
    }
  }
});

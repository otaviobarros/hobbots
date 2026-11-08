import { goodAtFromInstructions, type RoleId } from "@hobbots/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What a hob is good at becomes a stored, versioned field (ADR 032). Until now the profile worked it
// out from the chores under their heading in the instructions, or else the starter role's note, so
// every hob and every configuration version is filled with exactly that, and the profile shows the
// same words after this as before. A title of your own with no chores gets none. One longer than
// the limit, which chores of up to 4,000 characters allow, is shortened at the last word that fits.
export default Effect.gen(function* () {
  // Rows are read and written by their column names, as they are stored.
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  yield* sql`ALTER TABLE agents ADD COLUMN good_at TEXT`;
  yield* sql`ALTER TABLE agent_config_versions ADD COLUMN good_at TEXT`;
  const agents = yield* sql<{ id: string; role: RoleId | null; instructions: string }>`
    SELECT id, role, instructions FROM agents`;
  for (const agent of agents) {
    yield* sql`UPDATE agents SET good_at = ${goodAtFromInstructions(agent)} WHERE id = ${agent.id}`;
  }
  const versions = yield* sql<{ agent_id: string; version: number; role: RoleId | null; instructions: string }>`
    SELECT agent_id, version, role, instructions FROM agent_config_versions`;
  for (const version of versions) {
    yield* sql`UPDATE agent_config_versions SET good_at = ${goodAtFromInstructions(version)}
      WHERE agent_id = ${version.agent_id} AND version = ${version.version}`;
  }
});

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Who made each configuration version, and who summoned each hob (ADR 034). Only you could create or
// change a hob until now, so every existing version is recorded as yours, as JSON text, and every
// existing hob as summoned by you, for no Task, with you asked. The hob that summoned another is not
// a foreign key, so deleting an archived hob never has to wait for the hobs it summoned.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_config_versions ADD COLUMN actor TEXT NOT NULL DEFAULT '{"_tag":"You"}'`;
  yield* sql`ALTER TABLE agents ADD COLUMN summoned_by TEXT`;
  yield* sql`ALTER TABLE agents ADD COLUMN summoned_for TEXT`;
  yield* sql`ALTER TABLE agents ADD COLUMN summoned_unattended INTEGER NOT NULL DEFAULT 0`;
});

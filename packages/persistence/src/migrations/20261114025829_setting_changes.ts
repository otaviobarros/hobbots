import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Each change to a hub setting that changes what hobs may do (#1357): the safety preset, the shared
// folders and "Summoning for every hob" (ADR 034), with who made it, when, and the value before and
// after as JSON, and the ids of the hobs it reached, read in the transaction that made it so a hob's
// edit racing it cannot blur which policy the hob held. Settings and each hob's History keep them
// after the journal is compacted (ADR 013), as hobs' status changes are (0085). Nothing was
// recorded before, so the table starts empty.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE setting_changes (
      id TEXT PRIMARY KEY,
      revision BIGINT NOT NULL UNIQUE,
      setting TEXT NOT NULL CHECK (setting IN ('safetyPreset', 'approvedFolders', 'summoningForEveryHob')),
      actor TEXT NOT NULL,
      before_value TEXT NOT NULL,
      after_value TEXT NOT NULL,
      reached TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});

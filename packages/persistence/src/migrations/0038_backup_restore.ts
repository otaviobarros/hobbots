import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Backup and restore (ADR 026). A device revoked by a restore keeps its row, with `restore` as the
// reason, so Settings › Devices shows who to pair again; a device you revoked yourself has none.
// Each restore this database came back from is one row: when it was restored, when and by which
// Hobbots version the backup was made, the data folder set aside beside the restored one, the hob
// folders the backup named that this computer lacks (JSON text), and when work was resumed. Until
// then the hub holds work: the latest row with no `resumed_at` keeps the dispatcher off.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE devices ADD COLUMN revoked_reason TEXT`;
  yield* sql`
    CREATE TABLE restores (
      id TEXT PRIMARY KEY,
      restored_at TEXT NOT NULL,
      backup_made_at TEXT NOT NULL,
      backup_version TEXT NOT NULL,
      set_aside TEXT,
      missing_folders TEXT NOT NULL,
      resumed_at TEXT
    )
  `;
});

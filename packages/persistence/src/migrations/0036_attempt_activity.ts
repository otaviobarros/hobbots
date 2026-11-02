import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What an Attempt did, as the Workbench shows it (ADR 023): the commands it ran, the files it
// changed and the scans of its hob's folders those changes were found by. Each row names its
// Attempt and the Attempt's Task. A file change is one row per Attempt, folder and path, rewritten
// as later scans find more, so the end-of-turn compare is the row that stays.
//
// The heavy details are not rows: a command's whole output and a file's kept contents are files in
// the hub's data folder, kept once per SHA-256 (`*_content_id`). `details_cleared_at` is set when
// they were cleared past the retention window; the rows stay as long as their Task. A file
// version is JSON text, `shared_with` a JSON array of Attempt ids, booleans 1 or 0.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE attempt_commands (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        step_id TEXT NOT NULL,
        command TEXT NOT NULL,
        folder TEXT NOT NULL,
        sandboxed INTEGER NOT NULL,
        live_output INTEGER NOT NULL,
        state TEXT NOT NULL,
        exit_code INTEGER,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        output TEXT,
        log_content_id TEXT,
        log_total_bytes BIGINT,
        log_omitted_bytes BIGINT,
        log_not_kept TEXT,
        details_cleared_at TEXT,
        UNIQUE (attempt_id, step_id)
      )
    `;
  yield* sql`CREATE INDEX attempt_commands_log ON attempt_commands (log_content_id)`;
  yield* sql`
      CREATE TABLE attempt_file_changes (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        folder TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        moved_from TEXT,
        before_version TEXT,
        after_version TEXT,
        before_content_id TEXT,
        after_content_id TEXT,
        shared_with TEXT NOT NULL DEFAULT '[]',
        settled INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        details_cleared_at TEXT,
        UNIQUE (attempt_id, folder, path)
      )
    `;
  yield* sql`CREATE INDEX attempt_file_changes_before ON attempt_file_changes (before_content_id)`;
  yield* sql`CREATE INDEX attempt_file_changes_after ON attempt_file_changes (after_content_id)`;
  yield* sql`
      CREATE TABLE attempt_folder_scans (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        folder TEXT NOT NULL,
        phase TEXT NOT NULL,
        files_scanned INTEGER NOT NULL,
        stopped TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL
      )
    `;
  yield* sql`CREATE INDEX attempt_folder_scans_attempt ON attempt_folder_scans (attempt_id)`;
});

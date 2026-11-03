# Backing up, losing the data folder and restoring brings the hub back

- **Date:** 2026-11-03
- **Issue:** [#452](https://github.com/otaviobarros/hobbots/issues/452)
- **Pull request:** [#605](https://github.com/otaviobarros/hobbots/pull/605)
- **Commit:** not yet on `main` (ran on the pull request branch at `fb6a7e3`, which builds on `main` at `002169f`)
- **Setup:** Linux x86_64, Node 26.13.0, the fake runtime, SQLite. Browser case in Chromium against a hub from source serving the web build, with Aldric leading Quill and Ada on the scripted Black Friday Quest. Hub cases on real SQLite files in temporary data folders.
- **Result:** Passed with gaps. Slice 15's done-when check holds: a backup made from Settings, the data folder deleted, and the backup restored from Welcome brings back the threads, the Quest and what the hobs made. No backup file holds a key, token or sign-in. The desktop app and real Claude Code were not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OP-036]` | With Aldric's Quest waiting on Ada's question, Settings › Backup & export backs up into a folder of its own and shows where. The hub stops, its data folder is deleted, and a new hub starts on an empty one. Welcome's "Restore a backup" reads the backup and shows 3 hobs, 1 thread, 1 Quest and its Tasks before anything changes. "Restore and restart" restores it, and the hub starts again in place. The browser, revoked by the restore, pairs again. Home says work is held, Settings shows the restore and the data set aside, Devices lists the old browser under "Revoked by a restore", Resume work releases the hold, and the Quest's thread shows the message and Ada's question again. | ✅ 4 of 4 runs |
| `[TC-OP-021]` | A hub with a hob, a thread and message, a Quest whose Task finished with an artifact, workspace, Workbench and tool-log files is backed up from its open connection. Its data folder is deleted and the backup restored. Every record and file comes back, the port comes back without remote access, the installation gets a new ID, and work is held. | ✅ |
| `[TC-OP-022]` | The window key, a charm's private key, runtime sign-ins beside the data folder, an environment token, a device token hash and a pairing secret hash appear in no backup file. A token pasted into a chat message does. Every file and folder is owner-only. | ✅ |
| `[TC-OP-023]` | A missing folder, a folder without a manifest, a newer schema, an external database, a path outside the backup, a changed file and a link are each refused, and the data folder is unchanged. | ✅ |
| `[TC-OP-024]`, `[TC-OP-031]` | A backup from schema 37 restores and migrates on the next start. Before a migration, the hub backs itself up into `backups/` and keeps only the latest. | ✅ |

The persistence, server, web and desktop suites pass on SQLite, except `[TC-DP-008]`, which needs IPv6 that this container lacks.

## Gaps

- The desktop app's window, its backup folder dialogs and its restart were not run by hand. Its dialogs are covered by `[TC-OP-038]`.
- Real Claude Code was not run. The fake runtime played the Quest.
- PostgreSQL was not run. A backup there would hold no database, and a restore of one is refused with the steps to take instead.
- The hub's database copy holds the connection for the whole copy, so writes wait for it. This was not measured on a large database.

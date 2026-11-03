# ADR 026 — Backup, restore, export and diagnostics

Status: **Accepted.** Decides what [ADR 011](011-sqlite-storage.md), the [persistence contract](../architecture/persistence.md) and the [API and events contract](../architecture/api-events.md#operational-observability) leave open for OP-002 and OP-003 of the [MVP requirements](../product/mvp-requirements.md), for Slice 15 ([#16](https://github.com/otaviobarros/hobbots/issues/16)). Builds on the event journal of [ADR 013](013-event-journal.md), the redaction of [ADR 014](014-tool-policy-and-enforcement.md), the Tasks and Attempts of [ADR 018](018-tasks-and-quests.md), the credentials of [ADR 020](020-github-charm.md), [ADR 021](021-devices-and-remote-access.md) and [ADR 022](022-hob-github-app.md), and the Workbench records of [ADR 023](023-workbench.md).

## Context

A hub keeps everything in one data folder: the SQLite database, the Workbench contents in `activity`, the full tool logs in `tool-logs`, the default workspace in `workspaces/default`, and small files such as `installation-id`, `window-key` and `network.json`. Each hob's runtime state sits next to it, in the `-runtimes` folder. The credentials are elsewhere: the GitHub account's tokens and each hob's GitHub App key are items in the OS keychain, and devices hold their own tokens, of which the hub keeps only hashes.

ADR 011 says backups use the SQLite online backup API plus the artifact folder, and that moving data between installations is an export and an import. Four things are still open:

- **Backup.** What a backup holds, what it never holds, and how it stays consistent while the hub runs.
- **Restore.** Where a backup can be restored, what happens with a backup from an older schema, and what becomes of devices, Charm connections and work that was running.
- **Export.** What you get when you want your conversations and work history, not the whole hub, and how that differs from a backup.
- **Diagnostics.** Which IDs follow a Quest across hobs, Tasks, Attempts and runtimes, what a diagnostics report holds, and how it leaves no credential or secret-bearing prompt.

Some data in the database is private but not a credential. The [redaction rules](../architecture/permissions.md#secrets-in-tool-activity) leave your own messages and the hobs' replies unredacted, so a token you pasted into a message is stored as you wrote it. A backup has to hold that text to restore the hub. An export or a diagnostics report does not.

## Decision

### A backup is the whole hub, minus every managed credential

A **managed credential** is a value the hub keeps so that someone or something can authenticate: the keychain items, device token hashes, pairing secret hashes, the window key, runtime sign-ins, and the credentials in the hub's environment. The hub knows each one and where it keeps it. Text you wrote, and the replies hobs wrote, are content, not managed credentials, even when they contain a token.

A backup is a folder named `Hobbots backup <date> <time>.hobbots-backup`. It holds:

| Path | What it is |
|---|---|
| `manifest.json` | The format (`hobbots.backup`, version 1), when it was made, the Hobbots version, the storage backend, the schema version, the source installation ID, counts of hobs, threads, Quests and Tasks, and each file's size and SHA-256. |
| `database.sqlite` | The database, copied with the SQLite online backup API and then scrubbed (below). |
| `activity/` | The Workbench contents: redacted text, images and folded command logs, stored once per hash. |
| `tool-logs/` | The full logs of tool steps, already redacted when the hub wrote them. |
| `workspace/` | The default workspace from `workspaces/default`, where a hob without folders of its own works. |
| `settings/network.json` | The port. Remote access is always off in a backup. |

The schema version is the highest migration the database has applied, such as `36`.

A backup never holds a managed credential:

- **Keychain items:** the GitHub account's access and refresh tokens (ADR 020), each hob's GitHub App private key (ADR 022), and a connected desktop's device token (ADR 021). They stay in the keychain of the computer that has them.
- **Device secrets:** the scrub blanks every device token hash and deletes every pairing request with its secret hash. The `window-key` file is never copied; the hub writes a new one on every start.
- **The runtimes folder.** It holds each runtime's own session state and can hold its sign-in, such as Claude Code's credentials on Linux. A runtime is signed in again on the computer that runs it.
- **Environment credentials** such as `HOBBOTS_GITHUB_TOKEN` or a provider key. They are never written anywhere.
- **Hob folders outside the data folder.** They are your own folders and your own backups cover them. The manifest lists each hob's folders by path, so a restore can say which are missing.
- **Transient state:** the GitHub Charm's staging repositories and sandbox state in `charms/github`, and the `installation-id` file. A restore gets a new installation ID (below).

A backup holds your conversations as they are stored. A token you pasted into a message is content, and the backup keeps it as you wrote it, even when it is one of the managed credentials above. A backup restores your history exactly, so it does not redact what you wrote. The restore summary and the Back up now screen both say so. It is written owner-only (`0700` folders, `0600` files), and it is not encrypted in this version. The hub refuses a destination inside any hob's folder, since a hob could read it there. Encrypting a backup with a passphrase is a later change with its own format version.

### Making a backup while the hub runs

1. Settings › Backup & export › **Back up now** asks where to save the backup.
2. The hub places a **cleanup hold**: the jobs that delete files, the 30-day Workbench cleanup and the unreferenced-file sweep, do not run until it is released. New files can still be written.
3. The hub places a **workspace hold** on the default workspace, the one copied folder that hobs write to. No turn that can write there starts: a turn of a hob without folders of its own, or an unsandboxed turn (ADR 014). The backup waits for such turns already running to end. Settings shows which hob it waits for, with **Stop** and **Cancel backup**. A wait longer than 10 minutes cancels the backup and says why. Turns of sandboxed hobs in their own folders go on as usual.
4. It copies the database with `backup()` from `node:sqlite` on the hub's own writing connection, a few hundred pages at a time, so the hub keeps serving. Writes through that connection land in the copy; the search worker's connection only reads. The copy is a consistent snapshot of the moment it finishes.
5. It copies the default workspace, then releases the workspace hold. Nothing wrote to it between the snapshot and the copy, so its files match the records in the snapshot.
6. It opens the copy, runs the scrub and checks it with `PRAGMA integrity_check`.
7. It copies `activity` and `tool-logs`. Their files are written once, named by hash or by step, and never rewritten. Nothing is deleted while the cleanup hold stands, so every file the snapshot names is still there. Files written after the snapshot are copied too, and are harmless: the next sweep after a restore deletes them, since no record names them.
8. It writes `manifest.json` last, then releases the cleanup hold. A backup folder without a manifest is incomplete and a restore refuses it.

Both holds live only in the hub's memory on SQLite: a hub that stops during a backup releases them, and the half-written backup has no manifest.

Settings shows progress, the result and its size, or the failure with its reason. A failed backup deletes what it wrote.

Before the migrator applies a new migration on an update, the hub makes the same backup into `backups/` in its data folder and keeps only the latest one. The data folder is already out of every hob's reach (ADR 014).

### Restore

A restore never runs into a running hub. It runs in two places:

- **Settings › Backup & export › Restore** on the hub. The app shows a summary first: when the backup was made, by which Hobbots version, the counts in the manifest, which hob folders are missing on this computer, and what does not come back (devices, the keychain items, runtime sign-ins). After you confirm, the app stops the server and restores.
- **A fresh data folder.** "I already use Hobbots" on Welcome offers **Restore a backup**, with the same summary, before any server starts. A hub without the app runs the server's `restore` command, which refuses when a hub is using the folder.

The restore itself:

1. It checks the manifest and every file's SHA-256 before it changes anything. A missing file or a wrong checksum refuses the restore.
2. A backup with a newer schema than this Hobbots knows is refused: "This backup is from a newer Hobbots. Update Hobbots first." An older schema is restored as it is, and the migrator applies the newer migrations on the first start, as on any update.
3. It moves the current data folder aside as `<data folder>.before-restore-<date>`, and writes the backup into a new data folder. Settings lists the folder set aside with its size and a **Delete** button. Nothing deletes it on its own.
4. It writes a new `installation-id`, so every device, connected desktop and cursor sees a different installation. It then starts the hub.

On its first start after a restore the hub applies these rules in one transaction, before it serves anything:

- **New journal epoch.** The journal gets a new epoch, as ADR 013 already requires. Every client starts a fresh sync generation and refetches.
- **Every device is revoked.** Device records are kept as revoked, with "Revoked by a restore" as the reason, so Settings › Devices shows who to pair again. Their token hashes are blanked and pairing requests deleted, which a SQLite backup's scrub already did and a PostgreSQL backup still needs. An older backup must never bring back a device revoked after it. The hub's own window keeps working with its new window key. Remote access is off until you turn it on.
- **Work is held.** The hub runs its normal recovery sequence ([execution lifecycle](../architecture/execution-lifecycle.md#recovery-sequence)): an Attempt left live ends as interrupted, and a tool call with no outcome is uncertain. A Charm call left sending becomes uncertain. Then the dispatcher stays off: no backpack item is delivered, no continuation starts, no deadline fires and no queued chat message is sent. Time passed between the backup and the restore, and some of that work may already have happened. The restore summary in the app says how much work is held, and **Resume work** turns the dispatcher on. Until then Home and the Quest tab say "Work is held after a restore".
- **The GitHub account** is connected again only if this computer's keychain still has its item. Otherwise Settings › GitHub says to connect, as after a disconnect (ADR 020).
- **A hob's own GitHub App** whose key is not in this computer's keychain needs a reconnect, with the reason "The app's key is not on this computer" (ADR 022). Its GitHub actions fail with that reason and never run as you.
- **Runtime sessions.** A thread keeps its runtime session IDs. A session the runtime no longer has starts fresh, with the briefing a thread gets on a new runtime ([ADR 017](017-switching-brains.md)).
- **Backup holds.** A cleanup or workspace hold recorded in the database is cleared.
- **Hob folders.** The restore summary lists each hob folder that is not on this computer, so you can set that hob's folders again.

### Export

An export is your conversations and work history in a form you can read and keep, without Hobbots. It is not a backup: it cannot be restored, it covers only what you chose, and it is redacted.

| | Backup | Export |
|---|---|---|
| What for | Getting the hub back, here or on another computer | Reading, keeping or sharing your history |
| What it covers | Everything in the data folder that is not a credential | One thread, one hob, or everything |
| Format | The database itself, in this schema | Markdown for people and versioned JSON for programs |
| Restorable | Yes | No; importing is a later decision |
| Redacted | Only where the hub already stores redacted text | All text, your messages and replies included |
| Hob configuration | Yes, as stored | The hob's name, role and brain, as a record |

**What you can export.** Settings › Backup & export and the thread and hob menus offer: this thread; this hob, which is its threads, the Quests it led and the Tasks it worked on; or everything. For a Quest that spanned several hobs, a hob's export holds that hob's Tasks in full and the rest of the tree as titles and states only. Another hob's Quest in that tree is its goal and state, without its acceptance.

An export is a folder named `Hobbots export <what> <date>`:

| Path | What it is |
|---|---|
| `README.md` | What was exported, when, by which Hobbots version, and that redaction is best effort. |
| `threads/<date> <title>.md` | Each thread as Markdown: who wrote each message and when, the replies, and each tool step as one line with its outcome. |
| `quests/<date> <title>.md` | Each Quest as a tree: each Task's hob, state, result, artifacts, questions with answers and notes, and each Attempt's outcome, commands and changed files as lists. |
| `files/` | The files the Tasks made, copied from the hob's folders (below). |
| `export.json` | Everything above as data: format `hobbots.export`, version 1, with the hub's own IDs, so a program can read it. |

- **Artifacts.** A file artifact is copied into `files/<task id>/` when it is still a regular file in the hob's folders, up to 100 MiB each and 1 GiB per export. A file that is UTF-8 text goes through the redactor like every other string. Any other file is copied as it is only when the redactor finds nothing in its bytes. Past the limits, when it is gone, or when it holds a secret that cannot be redacted, the Quest file lists it with its path and why it was not copied. A link or text artifact is written in place.
- **Work history.** The commands and file changes the Workbench recorded are listed. Their stored contents and logs are not, since they belong to a backup.
- **Usage.** Each reply's usage goes in as #398 records it. This ADR does not change how usage is recorded.
- **Redaction.** Every string goes through the hub's redactor, known values and secret shapes alike, your own messages and the replies included. Briefs and prompts are text like any other and are redacted the same way. A secret the redactor cannot recognize still passes through, and the README says so.
- **No credentials.** An export reads nothing from the keychain or the runtimes folder, and holds no device record, token hash or pairing request.
- Export folders follow the same destination rule as backups: never inside a hob's folder.

Moving a hob's configuration to another hub stays open (Configuration, in the [open questions](../product/open-questions.md)). The export's hob record is not that format.

### The IDs that follow work

Diagnostics follows work with IDs the hub already stores, not by reading prose ([agent model](../architecture/agent-model.md)):

| ID | Follows |
|---|---|
| `questId` | One Quest across every hob that worked on it. It is the root of a trace. |
| `taskId` and `parentTaskId` | Each Task and its place in the tree. |
| `delegationId` | One hand-over of a Task from a lead to a member. |
| `attemptId` | One try at a Task, with its outcome. |
| `agentId` | The hob that did it. |
| `threadId` and `messageId` | The conversation and the turn. A chat turn outside a Quest is followed by these. |
| `runtime`, `executorId` and `runtimeSessionId` | Where the turn ran. A session ID is namespaced by its runtime and executor. |
| Backpack item ID | A delivery and its tries (ADR 019). |
| Charm call ID and approval ID | A GitHub write and the decision that allowed it. |
| Journal `sequence` and `causationId` | The order of events and which event caused another (ADR 013). |

Every journal entry carries the IDs that apply (ADR 013). When OpenTelemetry tracing arrives, a span carries the same IDs as attributes, with the Quest as the trace. The exporter, its backend and any telemetry stay open, and the hub sends nothing anywhere by itself.

### Diagnostics

Settings › Diagnostics shows what is wrong now and lets you follow one piece of work:

- **Now:** each runtime's health and its fix, as Settings › Providers shows it; work that stalled, such as an expired claim, a backpack item past its tries or an Attempt with no progress; the errors of the last startup's recovery; and whether work is held after a restore. Each shows what to do.
- **Follow a Quest:** pick a Quest, or open Diagnostics from a stalled Task. It shows the tree across hobs, with each Task's Delegations and Attempts, where each ran, the backpack items it waits on and its recent journal events, by type and time.

**Copy report** makes a diagnostics report and shows it in full before it copies it, or saves it as `hobbots-diagnostics-<date>.json`. The hub never sends it.

A report holds:

- The Hobbots version, the schema version, the storage backend, the operating system and architecture, and the app's Electron and Node.js versions.
- Each runtime's name, version and health, and whether it is signed in, without the account.
- For the Quest followed: the IDs above, each Task's hob, state and timestamps, each Attempt's outcome, the tag of each error with its redacted message, each backpack item's kind, state and tries, and the journal entries' sequence, type, time and IDs.
- The stalled work and recovery errors of the Now view, in the same form.

A report never holds message text, briefs, prompts, replies, Task results, tool step labels, command lines, tool output, file contents, keychain items, device records or the installation ID. Task titles go in only when you turn on **Include titles**, which is off. Paths become `~` for your home folder and `folder 1`, `folder 2` for each hob folder.

Redaction works in three layers, so a later field cannot leak by accident:

1. **An allowlist.** The report is encoded from its own Effect Schema, which names every field it may hold. A field that is not in the schema is not in the report, so a new column never reaches it unnoticed.
2. **The redactor.** Every string that is in the schema, error messages included, goes through the hub's redactor, known values and secret shapes alike.
3. **A final check.** Before it shows the report, the hub searches it for every credential it knows by value and every secret shape. A match refuses the report and logs which field held it, never the value.

### PostgreSQL later

Export and diagnostics read through the same `SqlClient` and work unchanged on PostgreSQL. Backup and restore change in one place, the database copy:

- On PostgreSQL the hub does not copy the database. The operator backs it up with PostgreSQL's own tools, such as `pg_dump` or the provider's snapshots. The hub's backup then holds the manifest, with `database: external` and the schema version, and the files.
- The operator follows three steps, and the hub refuses them out of order:
  1. **`hobbots backup begin`** places the cleanup hold and the workspace hold, waits for the turns that hold blocks, and answers with a backup ID. On PostgreSQL both holds are a row in the database, so every server process honours them. The holds expire after one hour.
  2. The operator takes the database backup with PostgreSQL's tools while the holds stand. The holds row is in that backup too; a restore clears it.
  3. **`hobbots backup files <id>`** copies the default workspace, `activity` and `tool-logs`, writes the manifest and releases the holds. An expired or unknown ID is refused, and the operator starts again from step 1, since a file could have changed or gone after the holds lapsed.
- So every file the database backup names is still there when the files are copied, and the default workspace matches the database, as on SQLite.
- The hub cannot scrub a database backup the operator takes, so on PostgreSQL that backup still holds the device token hashes and pairing secret hashes. Each is a SHA-256 of a 256-bit random secret, which cannot be turned back into a token (ADR 021), and the first-start rules after a restore blank them and revoke every device. The operator keeps that backup as private as the database itself.
- A restore loads the database with PostgreSQL's tools to the same schema version, then runs the hub's restore with the files. The first-start rules after a restore are plain SQL in one transaction and run the same on both databases.
- The checks that run on SQLite run on PostgreSQL in CI too, except the copy itself.

## Rationale

A backup has to bring the hub back exactly, so it is the database itself, not a format of its own. The online backup API copies it without stopping the hub. Two narrow holds keep the snapshot and the files consistent: deletes wait, and only the turns that can write to the one copied folder hobs use wait. Every other turn keeps running, so a backup interrupts as little work as it can and never copies a file that disagrees with its record.

Managed credentials stay out because the keychain, not the data folder, is where they live, and a backup travels further than the computer it came from. What you wrote stays in, because redacting it would make the restore inexact, and naming the two apart keeps the rule testable. Scrubbing the copy, rather than filtering the live database, keeps the hub untouched while it runs. Revoking devices after a restore is the only safe answer to an older backup: it can never bring back a device you revoked since. Pairing again costs one prompt per device.

Holding work after a restore is the honest answer to time that passed. The hub cannot know which effects happened after the backup, so it does not repeat any until you say so. Recovery already treats unknown outcomes as uncertain; the hold extends that to work not yet started.

An export answers a different need: reading your history without Hobbots. Markdown opens anywhere and versioned JSON lets a program read it, while a SQLite file needs Hobbots and our schema. Keeping it unrestorable avoids a second restore path with its own rules; importing can be decided with configuration portability.

A diagnostics report is something you paste into an issue or a chat. Building it from an allowlist, instead of stripping a full dump, means a field added later stays out until someone adds it on purpose. The final check catches what the first two layers miss.

Folders, rather than single archive files, need no new dependency and can be inspected with any file manager. A single-file format can come later with a new format version.

## Consequences

- Settings gains Backup & export and Diagnostics, and Welcome's "I already use Hobbots" gains Restore a backup. Screens 1 and 13 of the [screen inventory](../design/screens-and-flows.md) change with #452, #453 and #455.
- The hub gains a cleanup hold and a workspace hold for the length of a backup, and a held dispatcher after a restore, with Resume work, and "Revoked by a restore" as a device's revoke reason.
- The data folder gains `backups/` with the latest backup before a migration, and a restored hub leaves its earlier folder beside it until you delete it.
- The redactor runs over message and reply text for exports, which it does not do for stored messages.
- The first-launch setup tests use `TC-OP-001` to `TC-OP-015`. Slice 15's backup, restore, export and diagnostics cases start at `TC-OP-016`.
- **#452** builds backup, the scrub, restore with its first-start rules and the pre-migration backup. **#453** builds export. **#455** builds Diagnostics and the report. **#456** shares the runtime health that Diagnostics shows. **#457** proves the slice end to end and points ADR 011's backup line to its evidence.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- A backup made while a reply streams, followed by deleting the data folder and restoring, brings back the threads, Quests, Tasks, artifacts, Workbench contents and usage, on SQLite. Not proven yet: [#452](https://github.com/otaviobarros/hobbots/issues/452).
- A hob that edits one file and deletes another in the default workspace while a backup runs is held until the copy is done, or the backup waits for its turn to end. After a restore each artifact file matches the record that names it, and a file the records name is never missing. The cleanup jobs delete nothing while the hold stands. Not proven yet: [#452](https://github.com/otaviobarros/hobbots/issues/452).
- A backup holds no managed credential: with a GitHub account, a hob's app key, a provider key in the environment, approved devices, an open pairing request and the window key in place, and none of them typed into a message, no file in the backup holds any of their values, and the device token hashes are blank. A token-shaped value you typed into a message is in the backup and comes back as you wrote it. Not proven yet: [#452](https://github.com/otaviobarros/hobbots/issues/452).
- A backup with a missing file or a wrong checksum, or from a newer schema, is refused and changes nothing. A backup from an older schema restores and the migrator brings it up to date. Not proven yet: [#452](https://github.com/otaviobarros/hobbots/issues/452).
- After a restore every device is revoked and must pair again, the journal has a new epoch and the installation a new ID, an Attempt live in the backup is interrupted, a Charm call left sending is uncertain, and no backpack item is delivered until Resume work. A hob's app whose key is not in the keychain needs a reconnect. Not proven yet: [#452](https://github.com/otaviobarros/hobbots/issues/452).
- The earlier data folder is kept beside the restored one until you delete it, and a destination inside a hob's folder is refused. Not proven yet: [#452](https://github.com/otaviobarros/hobbots/issues/452).
- An export of a hob opens without Hobbots and holds its threads, Quests and artifacts, with a missing artifact listed and why. A token typed into a message is redacted in the export, and the export holds no device record or token hash. Proven at hub level with real files: `[TC-OP-040]` to `[TC-OP-044]`, and in the browser with the fake runtime: `[TC-OP-045]` and `[TC-OP-046]`. On PostgreSQL in CI only; the end to end proof of the slice is [#457](https://github.com/otaviobarros/hobbots/issues/457).
- A Quest that delegated to two hobs can be followed from Diagnostics through its Tasks, Delegations, Attempts and runtimes. Its report holds no message text, brief, command line or credential, and a report that would hold a known credential is refused. Not proven yet: [#455](https://github.com/otaviobarros/hobbots/issues/455).
- A logged-out runtime shows its fix in Settings › Providers and in Diagnostics. Not proven yet: [#456](https://github.com/otaviobarros/hobbots/issues/456).
- Usage over 7 and 30 days is the same after a backup and restore. Not proven yet: [#454](https://github.com/otaviobarros/hobbots/issues/454), [#457](https://github.com/otaviobarros/hobbots/issues/457).
- On PostgreSQL, `backup files` without a `backup begin` that still holds is refused, and a file named by a database backup taken under the holds is still there when the files are copied. The first-start rules after a restore, export and diagnostics give the same results on PostgreSQL. Not proven yet: [#457](https://github.com/otaviobarros/hobbots/issues/457).
- A manual backup and restore on the packaged Mac app is recorded as evidence, and the checks run in CI on SQLite. Not proven yet: [#457](https://github.com/otaviobarros/hobbots/issues/457).

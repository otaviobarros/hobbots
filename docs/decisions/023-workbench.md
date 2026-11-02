# ADR 023 — The Workbench

Status: **Accepted.** Refines screen 7 of the [screen inventory](../design/screens-and-flows.md), the Workbench rules of the [design specification](../design/ui-ux.md) and UX-002 and UX-006 of the [MVP requirements](../product/mvp-requirements.md) for Slice 12 ([#13](https://github.com/otaviobarros/hobbots/issues/13)). Builds on the Tasks and Attempts of [ADR 018](018-tasks-and-quests.md), the sandbox and redaction of [ADR 014](014-tool-policy-and-enforcement.md) and the event journal of [ADR 013](013-event-journal.md).

## Context

A hob works on your computer while you do something else. When it is done, or while it works, you want to see what it actually did: what it ran, what it changed and what it made. That view is the Workbench.

Many people who use Hobbots are not developers. A terminal or a diff is the wrong first thing to show them. They want to know, in plain words, what the hob was asked, what it did, what it made and what is still open. Developers still want the commands and the diffs, one click away.

Three things shape what the Workbench can honestly show:

- **Hobs edit files in two ways.** A file tool (Write, Edit) names the file it changes. A command (`npm run format`, `sed`, a script) can change any file in the hob's folders without saying which. Changes taken only from file tools would miss the second kind.
- **Hobs share folders.** Every hob works in the folders set up for it, and two hobs can work in the same folder at once.
- **Runtimes report differently.** Claude Code's hooks give a command's output when it ends. Other runtimes may stream it. A tool call's output is already redacted and stored with its step, with the whole of a long output kept as a log file in the hub's data folder.

Browser use is too large for the MVP. It moves to its own post-MVP slice ([#382](https://github.com/otaviobarros/hobbots/issues/382)), together with the Screenshot state it needed.

## Decision

### What it is

The Workbench is one Task's full view: its header, five tabs and a chat drawer. It shows one Attempt at a time, the latest by default.

It opens from the Task card, the Task drawer, a row of the Quest tab, the Workshop tab and "Open in Workbench" on a tool step. It opens in the chat's place, inside the same window. The hob panel, the right panel and a pinned Quest stay where they are. **Back to chat** (or **Back to the task** when it was opened from the drawer) returns to the same thread, scroll position and unsent message.

### The header

- The Task's title and its status tag.
- The owner's sprite and name, and who asked, as a chain: "asked by You → Aldric".
- The brain: the runtime's tile, runtime and model.
- Where it runs on the hub: **In the sandbox**, or the **Unsandboxed** tag (ADR 014).
- An Attempt picker when the Task has more than one Attempt: "Attempt 1 · 2 · 3". Every tab follows the chosen Attempt.

### The tabs

In this order:

| Tab | What it shows | Who it is for |
|---|---|---|
| **Summary** | What the hob was asked, what it did, what it made and what is still open | Everyone. It opens first. |
| **Changes** | Each file the Task added, edited or deleted, with a before and after | Anyone checking the work |
| **Files** | The files the Task made or touched, with previews | Anyone who wants the result |
| **Terminal** | The commands the Task ran and what they printed | Developers |
| **Browser** | "Coming soon": watching a hob use a browser comes in a later update | Nobody yet ([#382](https://github.com/otaviobarros/hobbots/issues/382)) |

Summary is always the tab the Workbench opens on. Changes, Files and Terminal are always reachable, never hidden.

### States

Every tab carries one honest label, taken from the hub's records, never from what a hob says:

| Label | When |
|---|---|
| **Live** | The chosen Attempt is running a turn now. The tab updates as records arrive. |
| **History** | The chosen Attempt is not running. The tab shows what was recorded. |
| **Unavailable** | Something was recorded but cannot be shown, with why: "Details were cleared after 30 days", "This brain does not report its commands", "This folder is too big to track changes". |
| **Not used in this Task** | The Attempt has no record for the tab, such as a Task that ran no command. The tab is greyed out but still opens, and says so in a sentence: "Quill did not use the terminal in this task." |
| **Coming soon** | Only Browser, until #382. |

Screenshot moves to #382 with the Browser. Computer control stays Later.

### Summary

Summary is built from records the hub already keeps. It makes **no model call**, so it costs nothing, is never wrong about what happened and works offline from the runtime.

- **What you asked.** The Task's brief: your message, or the lead's brief for a member's Task.
- **What happened.** Its checkpoints and steps in order, each with a mark: done, failed, waiting or next. Retries show as tries.
- **What it made.** The Task's Artifact references (files, links and text) and its changed files, each linked into Files or Changes.
- **Still open.** Its open questions, pending approvals, blockers and unresolved backpack items, each linked to where you act on it.
- **The result**, once the Task has one.

Each line links to the tab or the chat that holds the detail. Buttons at the end name the tabs the Task used: "See the 4 changed files", "See what ran in Terminal".

### Changes

- **Documents and Markdown** are shown rendered, before and after, with the changed parts marked.
- **Code and other text** is shown as a diff.
- **Images** are shown before and after side by side when both versions were kept (below). When the earlier one was not, Changes shows the current image with "Earlier version not kept" and says why. **Other files** show their name, size and kind.
- Each file is marked **Added**, **Edited**, **Deleted** or **Moved**.

### How changes are captured

The hub compares the hob's folders before and after the turn, so a change counts however it was made.

1. **A baseline when a turn starts.** Before the runtime starts, the hub lists every file in the hob's folders with its content hash, and keeps the contents it may need to show (below).
2. **A compare when it ends.** When the turn ends, however it ends, the hub scans again and records each difference as a file change of that Attempt. Kept contents that no change points at are dropped then.
3. **Along the way.** A file tool's change is recorded as soon as its call ends, and the hub rescans after each command, so Changes is Live during the turn. The end-of-turn compare is the record that counts.

Rules for the scan:

- **A hash is reused only when the file provably did not change.** To keep repeat scans cheap, the hub reuses a file's hash from an earlier scan only when its inode, size, modification time and change time (`ctime`), all to the nanosecond, match that scan, and that scan began after the file's last change. Any process can set a modification time, but none without root can set the change time: every write, and every attempt to restore the modification time, moves it. A file changed in the same clock tick as the scan that hashed it is hashed again, as Git does for "racily clean" files. The end-of-turn compare hashes every file whose change time is at or after the baseline began, so a command that writes the same number of bytes and puts the old modification time back is still caught.

- **Git and non-Git folders alike.** The scan reads the files themselves. It skips `.git` and `node_modules`, and in a Git folder it reads `.gitignore` files as data and skips what they ignore.
- **It never runs code from the folder.** No `git` command, hook, script or tool from the repository runs. Git can run code from a repository's own config, such as `core.fsmonitor`, so the hub never calls it.
- **It reads only the hob's folders.** It never follows a link out of them; a link is recorded as a link.
- **Bounded.** A folder past 100,000 files, or a scan that takes longer than 10 seconds, stops tracking for that folder. Changes then reads Unavailable for it, with why. Both limits are configurable.
- **Contents are kept for text up to 1 MiB and for images (PNG, JPEG, GIF, WebP) up to 10 MiB.** Larger and other binary files keep their hash, size and kind only, and their changes say "Earlier version not kept: too large" or "not a kind Hobbots can show".
- **Bounded per Attempt.** An Attempt keeps at most 256 MiB of contents. Past that, later changes keep their hash, size and kind only and say so. The limits are configurable.
- **Secrets stay out.** Kept contents pass through the same redaction as tool output. Files whose names mark them as secret, such as `.env` and private keys, keep no contents: Changes and Files say "Contents not kept: this file may hold secrets."
- **Shared folders are labeled.** When another turn ran in the same folder at the same time, a change there cannot be pinned on one hob. It is shown under both Attempts with "Changed while Ada was also working here."

Contents are stored in the hub's data folder, out of every hob's reach, once per content hash. The file change records point at them.

### Files

- The files the Task made (its Artifact references of kind file) and every file it added or edited.
- Previews for images, PDF, Markdown and plain text. Other files show their name, size and kind.
- **Show in Finder** in the desktop app on the hub. On another device or in a browser, **Download**, through the hub.
- Only files inside the hob's folders are listed or served. A file changed or deleted since the Task says so: "Changed since this task" or "No longer there".

### Terminal

The Terminal is a read-only record. You cannot type into it.

- **Each command** shows the command line, the folder it ran in, whether it ran in the sandbox, when it started, how long it took and whether it succeeded (its exit code).
- **Output** passes through the same redaction as tool output before it is stored or shown.
- **Live** where the runtime reports output as it comes. Where it reports output only at the end, as Claude Code's hooks do, a running command shows "Running · 12 s" and its output when it ends. Claude Code reports a command's output only when it ends; the fake runtime streams it when a scripted run asks to. Each command record says which (`liveOutput`).
- **Long output is folded.** A command keeps its first and last 8 KiB on its step, as today. Its whole output is kept up to 4 MiB as a log; past that, the log keeps its first and last 2 MiB and says how much was left out. An Attempt keeps at most 64 MiB of logs; past that, new commands keep only their first and last 8 KiB.
- **What runs without the Terminal** stays out of it. File reads, edits and searches are steps in Summary, not commands.

### How long history is kept

- **The records stay with the Task.** Commands, file changes, checkpoints and Artifact references are small rows. They are kept as long as the Task is.
- **The heavy details** (command logs and the kept file contents) are kept while the top Task is open and for 30 days after it ends, like backpack items (ADR 019). The window is configurable. After it, the tabs keep the list and read Unavailable for the details: "Details were cleared after 30 days."
- **The hob's files are never touched.** The Workbench only records. What the hob made stays in its folders until you delete it.
- Archiving a thread or retiring a hob deletes nothing here.

### The Task chat drawer

A drawer on the Workbench to talk about this Task without leaving it.

- What you write goes to the Task as a **note**, the note of ADR 018: it reaches the Task's lead as a message about this Task, through the lead's backpack. For a Task with no party, the lead is its owner.
- **Quick nudges** are notes with one tap, such as "Looks good", "Explain what you did" and "Keep going". The exact set is copy, not a decision.
- A note on a Task that has ended is refused, as ADR 018 decides.

### Keeping your place

- Switching tabs keeps each tab's place: its scroll, the selected file and folded output.
- Switching Attempts keeps the tab.
- The tabs follow the keyboard pattern for tabs: arrow keys move between them, and Escape goes back.
- A connected device or a browser on the tailnet gets the same Workbench (ADR 010). It shows the hub's files and commands; it never gives a hob access to that device.

### What is recorded

These refine the Artifact reference of ADR 018 and add two records. #384 adds them in a migration.

| Record | Holds | Lineage |
|---|---|---|
| Command | Command line (redacted), folder, sandboxed or not, start, end, exit code, output preview, log reference | Attempt, and the tool step it came from |
| File change | Path, kind (added, edited, deleted, moved, link), size and hash before and after, content references, "shared with" Attempts, why no contents | Attempt |
| Folder scan | Folder, start or end of turn, files scanned, whether tracking stopped and why | Attempt |

New records are written with their journal events in the same transaction (ADR 013), so every tab is Live from the event stream and catches up after a reconnect. Every runtime reports through the same records, and the fake runtime can script them.

## Rationale

Summary first serves the people who are not developers without hiding anything from those who are. Building it from records, not from a model, keeps it fast, free and true: it cannot invent a step.

Comparing the folders before and after the turn is the only way to catch edits a command makes. It also works for any runtime, since it does not depend on what a runtime reports. Reading files instead of running Git keeps repository code from ever running outside the sandbox. Size limits and reused hashes keep the scan cheap on large folders, and the label says when it gave up.

Saying when a change happened while another hob worked in the same folder is more honest than guessing whose it was.

Keeping the small records with the Task and the heavy details for 30 days keeps the Workbench useful for every Task while bounding disk use, and matches the backpack's window.

## Consequences

- Screen 7 and the design specification change to match: tab order, Summary first, the greyed Not used tabs and Browser as Coming soon.
- The Screenshot label leaves the MVP with the Browser view.
- The hub reads every file in a hob's folders at the start and end of each turn, and hashes again each file that changed since. Very large folders lose change tracking past the limits.
- The baseline copies small text files and images it has not kept before. They are kept once per hash and dropped at turn end unless a change points at them.
- The data folder gains content stored once per hash, cleared with the logs after the retention window.
- #382 brings the Browser tab and its Live, Screenshot and History states.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- A Task that edits two files, one with a file tool and one with a command, and runs a command, records both changes and the command's output, redacted, on SQLite and PostgreSQL. Proven at hub level with the fake runtime: `[TC-GEN-082]`, the records themselves in `[TC-IN-173]` to `[TC-IN-177]`, the Attempt's content budget in `[TC-PE-282]` and `[TC-PE-286]`, a command left running by a restart in `[TC-PE-283]`, and the fake runtime's scripted writes in `[TC-PE-281]`, `[TC-PE-285]` and `[TC-PE-287]`.
- A command that rewrites a file with the same number of bytes and restores its modification time is still recorded as a change. Proven: `[TC-GEN-080]`.
- An image the Task overwrote or deleted shows its earlier version, and one past the size limit says "Earlier version not kept" with why. The records are proven at hub level: `[TC-GEN-082]`. Not shown yet: [#387](https://github.com/otaviobarros/hobbots/issues/387).
- Change capture works in a Git and a non-Git folder, runs no code from the repository, keeps no contents of a secret file and labels a change made while another hob worked in the same folder. Proven: `[TC-PE-276]`, `[TC-PE-277]`, `[TC-PE-280]`, `[TC-PE-284]`, `[TC-GEN-079]`, `[TC-GEN-081]`, `[TC-GEN-082]` and `[TC-GEN-083]`.
- Opening a finished Task shows Summary first with the header, a tab it did not use reads "Not used in this Task", Browser reads Coming soon, and going back keeps your chat and pinned Quest: not proven yet, [#385](https://github.com/otaviobarros/hobbots/issues/385).
- A finished Task's Summary names what it made and links to each file, with no model call: not proven yet, [#386](https://github.com/otaviobarros/hobbots/issues/386).
- Selecting a Task that edited files shows its changes, Live during the turn and as History after: not proven yet, [#387](https://github.com/otaviobarros/hobbots/issues/387).
- A file the Task made opens as a preview and shows in Finder from the app: not proven yet, [#388](https://github.com/otaviobarros/hobbots/issues/388).
- A finished Task's terminal shows history, not a live session, with long output folded: not proven yet, [#389](https://github.com/otaviobarros/hobbots/issues/389).
- A nudge from the Workbench reaches the Task's lead as a note: not proven yet, [#390](https://github.com/otaviobarros/hobbots/issues/390).
- Details past the retention window read Unavailable with why, and the hob's files are untouched. The cleared records and the untouched files are proven at hub level: `[TC-PE-279]`, `[TC-IN-177]` and `[TC-PE-278]`. Not shown yet: [#387](https://github.com/otaviobarros/hobbots/issues/387), [#389](https://github.com/otaviobarros/hobbots/issues/389).
- The whole slice runs end to end with the fake runtime on SQLite and PostgreSQL: not proven yet, [#391](https://github.com/otaviobarros/hobbots/issues/391).

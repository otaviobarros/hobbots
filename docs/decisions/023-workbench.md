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

The Workbench is one Task's full view: its header, five tabs and a chat drawer. It shows one Attempt at a time. With none chosen it opens on the latest Attempt that recorded work (a command, a changed file, a reference, a report or the result), so a retry that ended before doing anything does not hide the one that did; a running Attempt, or one whose stop was never confirmed, is shown whatever it recorded, and with none that recorded anything it shows the Task's current Attempt.

It opens from the Task card, the task sheet and "Open in Workbench" on a tool step. It opens in the chat's place, inside the same window. There is no right panel beside the chat: the quest sheet and the task sheet slide in over the chat column and close when the Workbench opens, so the Workbench takes the chat column's whole width. The hob panel stays where it is, and a pinned Quest stays as a quest button in the chat header. **Back to chat** (or **Back to the task** when it was opened from the task sheet) returns to the same thread, scroll position and unsent message.

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
- **What happened.** Its checkpoints and steps in order, each with a mark: done, failed, waiting or next. Retries show as tries. A hob tool call the hub refused on the Task shows as failed, with what the hob was told ([#575](https://github.com/otaviobarros/hobbots/issues/575)).
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
4. **Only the turn's own changes.** Several hobs can work in one folder at once, so a difference in the folder is the turn's only when the turn made it (#595). A file the turn's file tools name (Write, Edit, a delete) is its own. For a command, the hub lists the folders just before it runs, while the runtime waits for its start to be recorded, and again when it ends: what changed in between is the turn's, except a file another turn's file tool changed in that time: one named while the command ran, or still being written when it ended. A file tool whose end is never reported, because its runtime was lost or its turn ended first, counts as writing until then. Every other difference, such as another hob's or a person's edit, is left out. When another hob's command ran at some point while this one did, the hub cannot tell which of the two made a file either saw change in a folder both track, so each records it, labeled as changed while the other worked there, even if one of them settles before the other's command ends. A command a runtime reports only once it runs, with no chance to list the folders first, leaves its folders compared whole as before, every change labeled the same way.

Rules for the scan:

- **A hash is reused only when the file provably did not change.** To keep repeat scans cheap, the hub reuses a file's hash from an earlier scan only when its inode, size, modification time and change time (`ctime`), all to the nanosecond, match that scan, and that scan began after the file's last change. Any process can set a modification time, but none without root can set the change time: every write, and every attempt to restore the modification time, moves it. A file changed in the same clock tick as the scan that hashed it is hashed again, as Git does for "racily clean" files. The end-of-turn compare hashes every file whose change time is at or after the baseline began, so a command that writes the same number of bytes and puts the old modification time back is still caught.

- **Git and non-Git folders alike.** The scan reads the files themselves. It skips `.git`, `node_modules`, well-known build caches (`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`) and `.DS_Store` files, and in a Git folder it reads `.gitignore` files as data and skips what they ignore.
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
- Only files inside the hob's folders are listed or served. A file changed or deleted since the Task says so: "Changed since this task" or "No longer there". A file larger than the hub serves is compared by size only, so one still the size the Task left says "Too large to check for changes" instead of passing as unchanged.

### Terminal

The Terminal is a read-only record. You cannot type into it.

- **Each command** shows the command line, the folder it ran in, whether it ran in the sandbox, when it started, how long it took and whether it succeeded (its exit code).
- **Output** passes through the same redaction as tool output before it is stored or shown.
- **Exit codes come from what the runtime reports.** Claude Code has no exit code field: a command that exits non-zero fails its call, and the PostToolUseFailure hook's `error` starts with the line `Exit code N`, which the hub records as the exit code and leaves out of the output. A call that succeeds exited 0, unless the Bash tool's response carries `returnCodeInterpretation` (grep's "No matches found"), where Claude Code read a non-zero code as no error without saying which; that command, and one interrupted or moved to the background, records no exit code. A command whose exit code is not 0 is Failed. The fake runtime reports its commands through the same hook payloads, so tests with it hold for Claude Code.
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
- An image the Task overwrote or deleted shows its earlier version, and one past the size limit says "Earlier version not kept" with why. The records are proven at hub level: `[TC-GEN-082]`, and the Changes tab shows both in the browser: `[TC-UX-037]`.
- Change capture works in a Git and a non-Git folder, runs no code from the repository, keeps no contents of a secret file and labels a change made while another hob worked in the same folder. Proven: `[TC-PE-276]`, `[TC-PE-277]`, `[TC-PE-280]`, `[TC-PE-284]`, `[TC-GEN-079]`, `[TC-GEN-081]`, `[TC-GEN-082]` and `[TC-GEN-083]`.
- Opening a finished Task shows Summary first with the header, a tab it did not use reads "Not used in this Task", Browser reads Coming soon, and going back keeps your chat and pinned Quest. Proven in the browser with the fake runtime: `[TC-UX-021]`, and opening from the drawer and the Quest tab in `[TC-UX-022]`.
- A finished Task's Summary names what it made and links to each file, with no model call. Proven in the browser with the fake runtime: `[TC-UX-030]`, a question waiting for you under Still open in `[TC-UX-031]`, the question's own thread reached from a Quest pinned elsewhere in `[TC-UX-032]`, and Still open saying nothing is open only after its reads answered in `[TC-UX-033]`. A retried step's Workbench opens on the Attempt that changed a file, past a retry that recorded nothing, and keeps an Attempt you choose in `[TC-UX-034]`. Summary reads only the records the hub already serves; nothing in it calls a runtime.
- Selecting a Task that edited files shows its changes, Live during the turn and as History after: documents rendered with their changed parts marked, code as a diff, and each file marked added, edited or deleted. Proven in the browser with the fake runtime: `[TC-UX-035]` and `[TC-UX-036]`.
- A file the Task made opens as a preview and shows in Finder from the app. Listing and serving only files inside the hob's folders, through no link, with secret files listed but never served, are proven at hub level: `[TC-GEN-140]` to `[TC-GEN-144]`. The Files tab's previews, Download in a browser, a file changed or gone since, a secret file and Show in Finder through the desktop app's bridge are proven in the browser with the fake runtime: `[TC-UX-040]` to `[TC-UX-044]`; the bridge's own checks in the desktop app's unit tests. Finder itself in the packaged app is not verified.
- A finished Task's terminal shows history, not a live session, with long output folded and redacted, and a running command counts its time and reads Cut off once its turn is stopped. Proven in the browser with the fake runtime: `[TC-UX-045]` and `[TC-UX-046]`. Output streamed as it comes is proven by the unit tests of the web client's live output; the fake streams it too fast for the browser to see it running.
- A nudge from the Workbench reaches the Task's lead as a note. Proven in the browser with the fake runtime: the lead's next turn reads it in `[TC-UX-050]`, a member's Task talks to its lead with the drawer's unsent note in `[TC-UX-051]`, an ended Task takes no note in `[TC-UX-052]`, and a nudge whose reply was lost goes out once when tapped again, even after the chat closed, in `[TC-UX-053]`.
- Details past the retention window read Unavailable with why, and the hob's files are untouched. The cleared records and the untouched files are proven at hub level: `[TC-PE-279]`, `[TC-IN-177]` and `[TC-PE-278]`. Changes keeps its list and says why in place of each file's contents: `[TC-UX-038]`. Not shown yet: [#389](https://github.com/otaviobarros/hobbots/issues/389).
- The whole slice runs end to end with the fake runtime. A Task that edits files with a file tool and a command and runs commands reads Live while its turn runs and History once it ends, from its records and from the event stream, with a client that lost its connection mid-turn catching up from its cursor, its kept contents, whole log and files served: `[TC-UX-060]`; a Task that runs no command records none while its changes and files are kept: `[TC-UX-061]`. Both at hub level over the HTTP API on SQLite and PostgreSQL. In the browser, the same kind of Task is followed through every tab while it runs and read again as History once it ends, with Browser reading Coming soon: `[TC-UX-062]`; and a Task that changed no file and ran no command greys out Changes, Files and Terminal, each saying why: `[TC-UX-063]` ([#391](https://github.com/otaviobarros/hobbots/issues/391), [evidence](../evidence/2026-11-03-workbench-end-to-end.md)). Real Claude Code is not verified.
- Every command on Claude Code keeps its exit code, read from the hooks as Claude Code reports it, and one that exits non-zero is Failed. Proven with Claude Code's recorded hook payloads and the fake runtime reporting the same: `[TC-RT-100]` to `[TC-RT-103]`; at hub level on SQLite and PostgreSQL: `[TC-RT-104]`; in the browser: `[TC-RT-105]` ([#591](https://github.com/otaviobarros/hobbots/issues/591)).
- A turn records only the changes it made, from its file tools and from listing its folders around each of its commands, while other turns work in the same folder; build caches and `.DS_Store` are left out. Proven at hub level on SQLite and PostgreSQL: `[TC-RT-106]` to `[TC-RT-108]`, and with the tool calls of two turns interleaved in an exact order: `[TC-RT-110]` to `[TC-RT-115]`; in the browser, two steps working in one folder at once each list only their own changes: `[TC-RT-109]` ([#595](https://github.com/otaviobarros/hobbots/issues/595)).

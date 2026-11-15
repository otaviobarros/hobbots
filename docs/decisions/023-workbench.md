# ADR 023 — The Workbench

Status: **Accepted.** Amended by [ADR 027](027-quest-room.md): the Workbench is one per Quest, docked in the Quest room under the lanes, its Summary tab and Task chat card go, and the Terminal is drawn with xterm.js. What it records, how it captures changes and how long it keeps them stand. Refines screen 7 of the [screen inventory](https://github.com/otaviobarros/hobbots/blob/07e7d13427061e49a0356ec9e7599995b948e59f/docs/design/screens-and-flows.md), the Workbench rules of the [design specification](https://github.com/otaviobarros/hobbots/blob/07e7d13427061e49a0356ec9e7599995b948e59f/docs/design/ui-ux.md) and UX-002 and UX-006 of the [MVP requirements](https://github.com/otaviobarros/hobbots/blob/07e7d13427061e49a0356ec9e7599995b948e59f/docs/product/mvp-requirements.md) for Slice 12 ([#13](https://github.com/otaviobarros/hobbots/issues/13)). Builds on the Tasks and Attempts of [ADR 018](018-tasks-and-quests.md), the sandbox and redaction of [ADR 014](014-tool-policy-and-enforcement.md) and the event journal of [ADR 013](013-event-journal.md).

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

The Workbench is the full view of what a Quest's hobs did: four tabs over every Task and Attempt in the Quest. A solo Task is a Quest room with one lane, so it gets the same Workbench ([ADR 027](027-quest-room.md)).

It is docked in the Quest room, under the lanes, beside the chat column. It never opens in the chat's place, and it has no Back. Folded, it is a strip of counts; a count, a lane or a link that names a Task opens it.

A lane filters it to that hob, and the attempt picked in a lane filters it to that try. For a Task with no try picked it shows the latest Attempt that recorded work (a command, a changed file, a reference, a report or the result), so a retry that ended before doing anything does not hide the one that did; a running Attempt, or one whose stop was never confirmed, is shown whatever it recorded, and with none that recorded anything it shows the Task's current Attempt.

A retry works on what the tries before it left in the hob's folders. So Changes and Files show a try together with the tries before it: each file once, from what it held before the first try that changed it to what the latest left, a file one try made and the next rewrote reads Added, a file a later try put back as it was drops out, a file deleted by one try stays Deleted whatever later tries move across its path, and a file changed while another hob worked in its folder keeps that warning through later tries ([#1218](https://github.com/otaviobarros/hobbots/issues/1218)). A file the shown try did not change says which tries did. Terminal shows the shown try's own commands.

Paths read from the Quest's folders: the folders its Quests work in and each folder a Task in it changed or touched files in, less any another of them holds. A member narrowed to a subfolder and its lead then show one file under the same path, and a list with files in more than one of these folders leads each path with its folder's name ([#643](https://github.com/otaviobarros/hobbots/issues/643)).

### The header

The Workbench has no header of its own any more. The Quest room's header holds the Quest's title, and each lane's header holds its hob, its brain, where it runs (**In the sandbox**, or the **Unsandboxed** tag of ADR 014) and the attempt picker, "Try 1 ✗ · 2" ([ADR 027](027-quest-room.md)).

### The tabs

In this order:

| Tab | What it shows | Who it is for |
|---|---|---|
| **Changes** | Each file the Task added, edited or deleted, with a before and after | Anyone checking the work |
| **Files** | The files the Task made or touched, with previews | Anyone who wants the result |
| **Terminal** | The commands the Task ran and what they printed | Developers |
| **Browser** | "Coming soon": watching a hob use a browser comes in a later update | Nobody yet ([#382](https://github.com/otaviobarros/hobbots/issues/382)) |

Summary was the first tab until [ADR 027](027-quest-room.md) made the lanes the summary. Changes, Files and Terminal are always reachable, never hidden. Each row names the hob it belongs to.

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

Replaced by the lanes of the Quest room ([ADR 027](027-quest-room.md)). The rule it set still holds there: what the work shows is built from records the hub already keeps, with **no model call**, so it costs nothing, is never wrong about what happened and works offline from the runtime. Its parts moved:

- The result, checkpoints, steps, retries and refused tool calls are beats, marks and the result in each hob's lane.
- What the Task made is in Files and Changes, and the result in the lane links to them.
- What is still open (questions, approvals, blockers, uncommitted work and backpack items) shows in the lanes, the Needs-you tray and the Inbox.
- What you asked is the Task's brief, behind its title in the lane.

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

The Terminal is a read-only record. You cannot type into it. [ADR 027](027-quest-room.md) draws it with xterm.js, as one scrollback per hob with a tab each and a split view, dark in every theme. The records below are what it draws.

- **Each command** shows the command line as a prompt line and its output as printed. The folder it ran in, whether it ran in the sandbox, when it started and how long it took sit on a dim line or a tooltip, and a failed command ends with its exit code.
- **Output** passes through the same redaction as tool output before it is stored or shown.
- **Commands print in color** ([#902](https://github.com/otaviobarros/hobbots/issues/902)). Claude Code runs them without a terminal, so before each command it runs a script from the hob's runtime folder (`CLAUDE_ENV_FILE`) that sets `FORCE_COLOR`, `CLICOLOR_FORCE`, `npm_config_color` and `pnpm_config_color`, and Git's `color.diff` and `color.status` to `always`. Only the hob's commands get it: Claude Code, its hooks and its own commands print as before. The Terminal keeps the escape sequences. Redaction reads output as a terminal shows it, so a secret a color code splits is still found. Hobbots' plain-text uses strip them: the reply's tool step and its log, and the whole log opened in a tab. The hob reads a command that succeeded as plain text, which the PostToolUse hook puts in place of its output. A command that failed reaches the hob as Claude Code returns it, which may hold escape sequences, because the PostToolUseFailure hook cannot replace its output. The script is written to a new file that then replaces the path, so a link a command left there never leads the hub to write outside the sandbox.
- **Exit codes come from what the runtime reports.** Claude Code has no exit code field: a command that exits non-zero fails its call, and the PostToolUseFailure hook's `error` starts with the line `Exit code N`, which the hub records as the exit code and leaves out of the output. A call that succeeds exited 0, unless the Bash tool's response carries `returnCodeInterpretation` (grep's "No matches found"), where Claude Code read a non-zero code as no error without saying which; that command, and one interrupted or moved to the background, records no exit code. A command whose exit code is not 0 is Failed. The fake runtime reports its commands through the same hook payloads, so tests with it hold for Claude Code.
- **Live** where the runtime reports output as it comes. Where it reports output only at the end, as Claude Code's hooks do, a running command shows "Running · 12 s" and its output when it ends. Claude Code reports a command's output only when it ends; the fake runtime streams it when a scripted run asks to. Each command record says which (`liveOutput`).
- **Long output is folded.** A command keeps its first and last 8 KiB on its step, as today. Its whole output is kept up to 4 MiB as a log; past that, the log keeps its first and last 2 MiB and says how much was left out. An Attempt keeps at most 64 MiB of logs; past that, new commands keep only their first and last 8 KiB.
- **What runs without the Terminal** stays out of it. File reads, edits and searches are marks in the hob's lane, not commands.

### How long history is kept

- **The records stay with the Task.** Commands, file changes, checkpoints and Artifact references are small rows. They are kept as long as the Task is.
- **The heavy details** (command logs and the kept file contents) are kept while the top Task is open and for 30 days after it ends, like backpack items (ADR 019). The window is configurable. After it, the tabs keep the list and read Unavailable for the details: "Details were cleared after 30 days."
- **The hob's files are never touched.** The Workbench only records. What the hob made stays in its folders until you delete it.
- Archiving a thread or retiring a hob deletes nothing here.

### The Task chat

Replaced by the chat column of the Quest room ([ADR 027](027-quest-room.md)). The thread stays beside the Workbench, so what you write goes to the lead as any message does, and a steer receipt shows where it went. A note the lead passes on is still the note of ADR 018. The quick nudges go with the card.

### Keeping your place

- Switching tabs keeps each tab's place: its scroll, the selected file and folded output.
- Switching Attempts, or the lane the Workbench is filtered to, keeps the tab.
- The tabs follow the keyboard pattern for tabs: arrow keys move between them, and Escape folds the Workbench.
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

Summary first served the people who are not developers without hiding anything from those who are; the lanes of ADR 027 now do that job. Building it from records, not from a model, keeps it fast, free and true: it cannot invent a step.

Comparing the folders before and after the turn is the only way to catch edits a command makes. It also works for any runtime, since it does not depend on what a runtime reports. Reading files instead of running Git keeps repository code from ever running outside the sandbox. Size limits and reused hashes keep the scan cheap on large folders, and the label says when it gave up.

Saying when a change happened while another hob worked in the same folder is more honest than guessing whose it was.

Each Attempt keeps its own records, each change against the start of the turn that made it, so a single try still reads as it ran. A later turn of the same Attempt replaces an earlier turn's record of the same path, so a file one turn made and the next edited still reads Edited within that try. The Workbench joins a Task's tries when it shows them, since what is on disk and in a commit is their sum: a retry shown alone hid what a stopped try made and called a file it rewrote Edited.

Keeping the small records with the Task and the heavy details for 30 days keeps the Workbench useful for every Task while bounding disk use, and matches the backpack's window.

## Consequences

- Screen 7 and the design specification change to match: tab order, Summary first, the greyed Not used tabs and Browser as Coming soon. [ADR 027](027-quest-room.md) later moves the Workbench into the Quest room and drops Summary and the Task chat card.
- The Screenshot label leaves the MVP with the Browser view.
- The hub reads every file in a hob's folders at the start and end of each turn, and hashes again each file that changed since. Very large folders lose change tracking past the limits.
- The baseline copies small text files and images it has not kept before. They are kept once per hash and dropped at turn end unless a change points at them.
- The data folder gains content stored once per hash, cleared with the logs after the retention window.
- #382 brings the Browser tab and its Live, Screenshot and History states.

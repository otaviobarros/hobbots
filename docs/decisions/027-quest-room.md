# ADR 027 — The Quest room

Status: **Accepted.** Amends the screens of [ADR 018](018-tasks-and-quests.md) (the card, the drawer, the quest and task sheets and the Quest tab) and the placement, Summary tab, Task chat and Terminal of [ADR 023](023-workbench.md). Refines screens 6, 7 and 17 of the [screen inventory](../design/screens-and-flows.md), the [design specification](../design/ui-ux.md), and UX-002, UX-006, OR-001 to OR-007 and IN-005 of the [MVP requirements](../product/mvp-requirements.md), for the Quest room slice ([#897](https://github.com/otaviobarros/hobbots/issues/897)). Builds on the Task tree of ADR 018, the backpack of [ADR 019](019-hob-backpack-and-continuations.md), the records of ADR 023 and the event journal of [ADR 013](013-event-journal.md).

## Context

Quests work, but following one is hard:

- **Too many layers.** The card in the chat opens the quest sheet. The quest sheet opens the task sheet. The task sheet opens the Workbench in the chat's place. Each layer has its own Back, so it is hard to tell where you are.
- **One Workbench per Task.** A Quest with three hobs has three Workbenches, and nothing shows the party working side by side.
- **Too much text.** Rows hold titles, owner names and the hobs' own long sentences. The hobs themselves show only as 22 px icons.
- **The Terminal is not a terminal.** Each command is a boxed card with Ran in, Sandbox, Started and Took fields.

Two more problems show once the work moves out of the chat. A message from the lead is easy to miss while you look at the work. And when you write to the lead while a Quest runs, nothing shows where your message went.

The records the screens need mostly exist: Tasks, delegations, checkpoints, hand-offs, questions, attempts, tool steps (members' steps are saved since [#892](https://github.com/otaviobarros/hobbots/issues/892)), commands and file changes. Three are missing: one read across a Quest's whole tree, a link from a note the lead passes on back to your chat message, and whether you have read a thread.

## Decision

### The room

Every Task opens a **Quest room**. A Task alone has one lane. When the owner brings in a party, lanes appear in place, as the Task becomes a Quest without changing its id (ADR 018). There is one screen to learn.

The room opens **beside the chat, never in its place**. Lanes and the Workbench fill the left. The thread stays as a column on the right: the same thread, scroll position and unsent message as the full chat. The lead's messages, your messages and the steer receipts happen in that column while the lanes react next to it.

- **Ways in.** The ticket under your request, the quest button in the chat header, and a link from the Inbox, a notification, a hob's peek on Home, a hob's History or a tool step's Open in Workbench. A link names the Task: the room opens with that lane lit, and on the Workbench tab the link was for.
- **The address** holds the open room, the lit lane, the Workbench tab and the chosen try, so a reload or a link brings the same view back.
- **Close room** gives the chat its full width again, at the same place. It is the only way out. There is no Back stack.
- **The chat column folds** to a rail with an unread dot, to give the lanes the width. The device remembers the choice.
- **Widths.** The chat column is about 360 px. At 1024 px it narrows to 300 px. At 960 px it starts folded and opens over the lanes.
- **The header** holds Close room, the Quest's title, its progress strip, the lineup of the party's sprites and a ⋯ menu with Pin quest and Cancel quest….
- **A thread can have several Quests.** Each keeps its own ticket under the message that started it, its own quest button in the header and its own room.
- **An ended Quest** keeps its room as a recap. Everything reads History, and nothing in it takes input except the Workbench.

### Lanes

There is one **lane per hob** on the Quest.

- **The lane header** shows the hob's sprite in its mood (working hops, waiting dozes), its name, its role ("Lead", "Leads Pip, Bram"), its Task's title and a state tag. Its brain, its folders and the Unsandboxed tag ([ADR 014](014-tool-policy-and-enforcement.md)) show there too, as the Workbench header showed them.
- **Nested Quests.** A member that leads its own Quest gets a group: its lane, with its members' lanes inside under a "Rook's party" label. The tree's structure stays visible.
- **Steps stay in their owner's lane.** A hob splitting its own work is not a party (ADR 018), so a step never gets a lane.
- **A hob with more than one Task** on the Quest keeps one lane, with its Tasks in order.
- **Many lanes.** A lane keeps a minimum width. When the lanes do not fit, the row scrolls sideways; a party of five or more always does. A sprite in the header lineup scrolls to its lane, flashes it and filters the Workbench.
- **Clicking a lane** filters the Workbench to that hob. Clicking it again shows everyone.

### What a lane shows

A lane is built from the hub's records. It makes **no model call**, so it costs nothing and cannot invent a step. In order:

- **Beats** for milestones and findings: the checkpoint's summary, cut with an ellipsis when it runs long.
- **Refused tool calls** as failed marks, with what the hob was told ([#575](https://github.com/otaviobarros/hobbots/issues/575)), and work left uncommitted (ADR 018) as a beat.
- **Marks** for what the hob did, from its tool steps, commands and file changes: `↗` read, `✎` edit with the lines added, `$` a command with ✓ or its exit code, `✕` deleted. Older marks fold into a count, so a long lane stays readable.
- **Hand-off chips** when work moves between hobs ("Landing copy → Ada" in Quill's lane, "← Landing copy from Quill" in Ada's), and "Briefed Quill, Ada and Pip" in the lead's.
- **A wait line** while the Task waits ("Waits on Ada's preview link").
- **A live "now" line** while a turn runs.
- **The result** once the Task ends.

Hobs are told to keep a checkpoint's summary to about eight words, with detail in a separate optional field that the Workbench can show and the lane never does ([#901](https://github.com/otaviobarros/hobbots/issues/901)). The guidance is a request to the model, so the lane still cuts what runs long.

### Acting in a lane

You act where the work is.

- **A question for you** shows lit in lantern in the lane of the hob that asked, with its options ([#740](https://github.com/otaviobarros/hobbots/issues/740), once it lands) and Answer in words. It is the same question as in the chat, the Needs-you tray and the Inbox, so answering in any of them answers it. Your answer still goes down the leads that passed it up (ADR 018), and the lane moves on.
- **A failed Task** turns its lane rose, says what stopped it and offers Retry and Reassign… in the lane.
- **Stuck work** (IN-007) shows in the lane of the hob it was handed to, as the stuck card with its actions, and as a Stuck tag on the ticket. It stays in Inbox › Needs you.
- **A ⋯ menu on each lane** holds Show in the Workbench, Retry (only when failed), Reassign… (only the hobs the hub would accept) and Cancel task…. The lead's lane adds Pin quest and Cancel quest….
- **The attempt picker** sits in the lane header once a Task has more than one try: "Try 1 ✗ · 2". Picking a try shows what it did in the lane and in the Workbench.
- **Outcomes and refusals** show in the lane, from what the hub recorded: Retrying…, Cancelling… until each Task confirms, Cancelled, Not confirmed, and a refusal with its reason. The controls act on the Task directly, never through the lead (OR-006), with the endpoints the Quest tab uses today.

### The Workbench

There is **one Workbench per Quest**, docked under the lanes.

- **Folded**, it is a strip of counts: "Workbench · Changes 4 · Files 2 · Terminal 3 · Browser Soon". Clicking a count or a lane slides it open on that tab. It can be dragged taller and folded again.
- **Filters.** Changes, Files and Terminal list every hob's work, each row with its owner's sprite. A lane filters every tab to that hob, and the attempt picked in a lane filters it to that try. With no try picked, each Task shows the Attempt ADR 023 picks.
- **Summary goes away.** The lanes are the summary. What Summary listed under Still open lives in the lanes, the Needs-you tray and the Inbox.
- **Labels stay**, per hob: Live, History, Unavailable with why, and Not used.
- **One read.** The Workbench reads the whole tree in one call and stays live through one stream for every hob ([#899](https://github.com/otaviobarros/hobbots/issues/899)). The same rules apply as per Attempt: redaction, the 30-day details window, the Unavailable reasons and the per-Attempt budgets. The per-Attempt endpoints stay for anything else that uses them.

Everything else ADR 023 decides holds: how changes are captured, what Changes and Files show, what is recorded and how long it is kept.

### The Terminal

The Terminal is drawn with **xterm.js, read-only**. It is the terminal engine VS Code uses, so colors, progress bars and spacing come out as the command printed them.

- **A tab per hob**, like terminal tabs, and Split to show them side by side.
- **One scrollback per hob.** Each command starts with a prompt line (`quill@site $ pnpm build`), then its output as printed. A failed command ends with its exit code in red. Where it ran, the sandbox, when and how long move to a dim line or a tooltip.
- **Live** as the stream delivers output. Where the runtime reports output only at the end, as Claude Code does, a running command shows "Running · 12 s".
- **Dark in every theme**, with its own palette that passes contrast, as real terminals do.
- **Accessible.** Text can be selected, copied and searched. A screen reader can read the output. The keyboard can always leave the terminal.
- **Loaded only when the tab first opens**, as its own chunk, so the room and the chat do not pay for it. `@xterm/xterm` 6.0.0 is about 88 KB gzipped.
- **Colors.** Claude Code runs commands without a TTY, so most tools print no color. Hob commands get the usual opt-in variables, such as `FORCE_COLOR` and `CLICOLOR_FORCE`. Redaction still catches a secret split by a color code, and output a hob reads back has the escapes stripped ([#902](https://github.com/otaviobarros/hobbots/issues/902)).

The component is built so that a later live terminal can attach it to a session and take keystrokes. That terminal is out of scope here.

### The chat

The chat stays your conversation with the lead. It is not a second place to follow the work.

- **A ticket replaces the card.** Under the request that started the Task, a one-line ticket shows the party's sprites, the title, "2 of 3 done", a "1 needs you" tag when something waits on you, and Open room. It updates live and never grows with the work. An ended Quest's ticket says how it ended. In a narrow chat column, as beside the room at 1024 px, one line has no room for all of that, so the ticket keeps a fixed second line: the title and the arrow on the first, and two sprites, how many more and the state under them.
- **The quest button** in the chat header stays, and a pinned Quest keeps it in every thread.
- **The lead says only what keeps you informed:** the plan when the Quest starts, a question no lead can answer, and the finish. The finish is one short summary of what was made, where it is and who did what. Between those the lead stays quiet, and it says more once you write to it ([#901](https://github.com/otaviobarros/hobbots/issues/901)).
- **Beats, marks and hand-offs** live only in the room.
- **The Task chat card goes.** The chat column replaces it. What you write goes to the lead, as any message does, and the lead decides which work it is about.

### Steer receipts

What you write while a Quest runs still goes to the lead (ADR 018). A **steer receipt** under your message shows where it went, with the hobs' sprites, as the hub records each step:

1. "Aldric is reading…" while the lead's turn on your message runs.
2. "Aldric got it", when the lead answers without passing it on. The receipt ends there.
3. "Aldric got it → passing to Ada…" once the lead passes it on as a note, naming each hob when there are several, and down through a nested lead.
4. "Ada picked it up" once the member's turn reads the note. A note held while the member waits on an approval says so, with why.

In the room, the same note shows as a dashed chip: "Your note: keep it to three sections" in the lead's lane, then "← Your note, via Aldric" in each lane it reached.

The receipt comes from records, never from what the lead says ([#900](https://github.com/otaviobarros/hobbots/issues/900)):

- A note the lead sends records the chat message whose turn sent it.
- The hub records when the receiving Task's turn picks a note up, and shows it in the Task tree and the journal.

### When you are elsewhere

Three levels, by how much it matters:

1. **Needs you**: a question that reached you, an approval or a failed Task. It goes to the Inbox, as today. A needs-you mark goes on the **lead's** tile in the sidebar, because you talk only to the lead. This replaces the mark on the asking hob's tile ([#824](https://github.com/otaviobarros/hobbots/issues/824)); the asking hob keeps its own state dot, and the Inbox names it as the one asking. A question or a failed Task also sends a desktop notification under "When a hob needs me", as approvals do.
2. **The lead wrote**: the plan, the finish or an answer to you. An unread dot shows on the lead's tile, on the thread in its chat list and on the folded chat rail. It clears when you read the thread. A finished Quest also sends a desktop notification, "Spring launch is done", under a new "When work finishes" setting.
3. **Routine progress** notifies nobody. Tiles keep their live working dot.

Clicking any of these opens the room, with the lane that needs you lit.

**The hub keeps whether you have read each thread**, as the last message you read. An unread dot then holds across every device on the hub (ADR 021), and clears everywhere once you read the thread on one.

### What goes

- The quest card and the Task card under a request, replaced by the ticket.
- The quest sheet, the task sheet and the Task drawer, with their routes and search parameters. Their parts move into the lanes and their menus.
- The Workbench page in the chat's place, its Back to chat and Back to the task, its Summary tab and its Task chat card.
- The Quest tab's control room, whose tree and controls are the lanes.

Their parts are reused inside the room where they fit: the diff, document, image and file previews, the question card, the answer path and the controls' outcome lines.

### Out of scope

- A live, typeable terminal for hobs.
- Browser use ([#382](https://github.com/otaviobarros/hobbots/issues/382)).
- Talking to a party member directly. You still talk only to the lead (ADR 018).

## Rationale

Opening the room beside the chat removes the mode switch. With the room in the chat's place, a message from the lead could reach you only as a badge on Back to chat, and you would keep going back and forth to check. With the thread as a column next to the lanes, you never lose the conversation, and you watch your steering land.

A lane per hob shows the team working side by side, which no list of rows does. Building lanes from records, not from a model, keeps them fast, free and true, as ADR 023 decided for Summary. Short beats and compact marks replace prose with the work itself, and the hand-off chips show work moving between hobs.

One Workbench per Quest matches how you think about the work: one job done by a team, not three separate jobs. Docking it under the lanes, folded until you want it, keeps the team in view while you dig into detail.

xterm.js is a real terminal engine, so the Terminal looks and behaves like one without imitating it. It is the heaviest choice, which is why it loads only with its tab. It also leaves room for a live terminal, which a styled log could not become.

A one-line ticket and a quiet lead keep the chat a conversation. The narrow column's second line keeps the title and what needs you readable instead of cutting them to nothing; it is still a fixed size, so the ticket never grows with the work. The steer receipt shows that your message is being acted on without the lead narrating it, and since it comes from records, it cannot claim a hand-off that did not happen.

The needs-you mark goes on the lead's tile because you talk only to the lead. A mark on a member would send you to a hob you cannot message. Keeping the read state on the hub makes the unread dot agree on every device.

## Consequences

- ADR 018's screens and ADR 023's placement, Summary, Task chat and Terminal drawing are amended here. Their records, rules and capture stay.
- Screens 6, 7 and 17 and the design specification change to match.
- The hub adds a tree-wide Workbench read and stream ([#899](https://github.com/otaviobarros/hobbots/issues/899)), the note's source message and pickup time ([#900](https://github.com/otaviobarros/hobbots/issues/900)), and a read marker per thread ([#910](https://github.com/otaviobarros/hobbots/issues/910)), each in a migration.
- Tool descriptions and briefings change for short checkpoints and a quiet lead ([#901](https://github.com/otaviobarros/hobbots/issues/901)).
- Hob commands run with color forced on ([#902](https://github.com/otaviobarros/hobbots/issues/902)).
- The web client adds `@xterm/xterm` and the addons it needs, in a chunk loaded with the Terminal tab ([#908](https://github.com/otaviobarros/hobbots/issues/908)).
- The quest card, the sheets, the drawer, the Workbench page and the Summary tab are removed, with their routes ([#903](https://github.com/otaviobarros/hobbots/issues/903), [#904](https://github.com/otaviobarros/hobbots/issues/904), [#907](https://github.com/otaviobarros/hobbots/issues/907)). Checks that used them are rewritten against the room.
- Settings › Notifications gains "When work finishes", and "When a hob needs me" covers questions and failed Tasks too ([#910](https://github.com/otaviobarros/hobbots/issues/910)).
- The orchestration, inbox and API contracts still name the drawer and the Quest tab. The issues that remove them update those contracts in the same pull request (STD-DOCS-002).

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- Every way in (the ticket, the header's quest button, an Inbox link and a notification) opens the room beside the chat with the right lane lit. Close room returns to the chat at the same place with the unsent message kept, and a reload or a link brings back the same room, lane, tab and try. Checked in the browser with the fake runtime for the ticket, the header's quest button and an Inbox link in `[TC-UX-201]`; the web client sends no notifications yet, so that way in is not proven ([#903](https://github.com/otaviobarros/hobbots/issues/903)).
- The room works at 1280, 1024 and 960 px in all four themes: the chat column is 300 px at 1024, starts folded at 960 and opens over the lanes, and keyboard focus never drops to the page. Folding the column is kept on the device. Checked in the browser with the fake runtime in `[TC-UX-202]` to `[TC-UX-207]` ([#903](https://github.com/otaviobarros/hobbots/issues/903)). A backpack row that had focus when its item is handled hands focus to its card's details, and only while the card still holds it: `[TC-UX-215]`, `[TC-UX-216]` ([#986](https://github.com/otaviobarros/hobbots/issues/986)). Answering a question in a lane, by a choice's key or its chip, moves focus to the lane's next waiting item, or else to its header, and a toast says what was sent: `[TC-UX-216]`, `[TC-UX-217]`; in the chat's Needs-you tray, focus moves to the next item or the composer: `[TC-UX-218]` ([#995](https://github.com/otaviobarros/hobbots/issues/995)).
- A Task alone opens a room with one lane, and lanes appear in place when a party joins, with no new id. Not proven yet: [#903](https://github.com/otaviobarros/hobbots/issues/903), [#905](https://github.com/otaviobarros/hobbots/issues/905).
- The fake Black Friday Quest shows a lane per hob, live, with beats, read, edit, command and delete marks, hand-off chips, waits and results, all from records with no model call. A nested Quest groups its members under their lead, a step stays in its owner's lane, and six lanes scroll sideways with the lineup jumping to each. Checked in the browser with the fake runtime in `[TC-UX-208]` to `[TC-UX-213]`, with every lane a region reached by the keyboard and Reduce motion stopping the hops and the flash, and the lane model in its unit tests `TC-UX-905-01` to `TC-UX-905-04` ([#905](https://github.com/otaviobarros/hobbots/issues/905)).
- A question answered in the asking hob's lane goes back down the leads to that hob and clears it from the room and the Inbox: `[TC-UX-240]`. A failed Task is retried from its lane and another is reassigned, a Task is cancelled from its hob's ⋯ menu, and an earlier try is picked with the Workbench following it: `[TC-CH-192]`. The Quest is cancelled from the lead's ⋯ menu, and a refused Reassign shows its reason in the lane: `[TC-CH-193]`. Each lane's ⋯ menu offers only what applies, works from the keyboard and gives focus back to its button: `[TC-CH-190]`. A step and a member's Task are each cancelled from their hob's lane: `[TC-OR-459]`, `[TC-UX-165]`. All checked in the browser with the fake runtime ([#906](https://github.com/otaviobarros/hobbots/issues/906)); a question with options waits on [#740](https://github.com/otaviobarros/hobbots/issues/740).
- One call returns a Quest's commands, file changes, files and tool steps across its Tasks and Attempts, nested Quests included, with one live stream for the tree, on SQLite and PostgreSQL, and a Task outside the caller's reach is refused. Not proven yet: [#899](https://github.com/otaviobarros/hobbots/issues/899).
- The docked Workbench lists a party's changes and files across hobs, and a lane and a try filter every tab. Not proven yet: [#907](https://github.com/otaviobarros/hobbots/issues/907).
- The Terminal replays each hob's commands with their colors and exit codes, writes live output, splits by hob, stays dark in the light themes, can be read by a screen reader, and adds to the bundle only in its own chunk. Not proven yet: [#908](https://github.com/otaviobarros/hobbots/issues/908). `pnpm build` and `git diff` print in color on Claude Code and the fake runtime, a secret inside colored output is redacted, and output a hob reads back has no escapes. Not proven yet: [#902](https://github.com/otaviobarros/hobbots/issues/902).
- The ticket replaces the card, updates live as Tasks start, wait, need you, fail and finish, and two Quests in one thread keep a ticket each. Checked in the browser with the fake runtime in `[TC-UX-220]` to `[TC-UX-223]`, a party of five beside the room at 1024 px included, with failed Tasks counted on the ticket in `[TC-CH-192]` ([#904](https://github.com/otaviobarros/hobbots/issues/904)). A finished Quest's ticket and its finish banner show one duration, which stays the same after its lead's turn ends and the page reloads: `[TC-UX-224]`, `[TC-OR-594]` ([#1007](https://github.com/otaviobarros/hobbots/issues/1007)).
- On the fake Black Friday Quest, the lead's chat messages are the plan, any escalated question and the finish, and checkpoint descriptions and briefings carry the short-summary guidance. Not proven yet: [#901](https://github.com/otaviobarros/hobbots/issues/901).
- A chat message the lead passes to one member, to two, to nobody and through a nested lead is traced to each note and to the turn that picked it up, on SQLite and PostgreSQL. A note held behind an approval reads as waiting with its reason. Not proven yet: [#900](https://github.com/otaviobarros/hobbots/issues/900). The receipt shows each of those steps live in the chat and the notes as chips in the lanes. Checked in the browser with the fake runtime for a note passed to one hob, to two, to nobody and held behind an approval in `[TC-UX-260]` to `[TC-UX-263]`; a note passed through a nested lead is checked in the unit tests only ([#909](https://github.com/otaviobarros/hobbots/issues/909)).
- A question, an approval or a failed Task marks the lead's tile, lands in the Inbox and sends a desktop notification. A message from the lead leaves an unread dot that clears on every device once the thread is read, a finished Quest notifies, and routine progress notifies nobody. The hub's read marker, on SQLite: `[TC-DP-250]`, `[TC-DP-251]`, and for a reply continued after you read it, even when another device's read of it lands late, `[TC-DP-252]`; the revision a chat reads through `[TC-UX-195]`; a chat folded beside the room leaves the thread unread `[TC-UX-202]`; and through the chat service with its events: `[TC-UX-190]`. Members' failed Tasks that wait on you: `[TC-OR-560]`. The lead's mark: `[TC-UX-191]`; the unread dot as a reply lands: `[TC-UX-192]`, and in a list of chats read while it landed: `[TC-UX-959]`. The desktop notifications for a question, a failed Task and a finished Quest, and what each opens: `[TC-IN-540]`, `[TC-IN-541]`, `[TC-IN-542]`. In the browser, a reply that lands elsewhere dots the chat and the hob's tile, and reading it clears both on a second device and after a reload: `[TC-UX-193]`. A member's failed Task in the Inbox, with Retry there and Open the task into the room: `[TC-IN-543]`, `[TC-IN-544]` (with a toast that says it went back and focus on the entry that takes its place, even when the hub's event lands before its answer, [#988](https://github.com/otaviobarros/hobbots/issues/988)), and a read of them that answers after the Task moved on: `[TC-UX-194]`. Clicking a notification opens the Quest room beside the lead's chat on the Task's lane. Not proven yet on the folded chat rail ([#903](https://github.com/otaviobarros/hobbots/issues/903)).
- A real Quest on Claude Code on macOS, with a party and a nested Quest, is followed and steered from the room alone: a question answered in a lane, a failed Task retried, a note steered from the chat with its receipt, and the Terminal showing each hob's commands. Not proven yet: [#911](https://github.com/otaviobarros/hobbots/issues/911).

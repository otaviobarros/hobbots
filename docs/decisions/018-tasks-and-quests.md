# ADR 018 — Tasks and Quests

Status: **Accepted.** Refines [orchestration](../architecture/orchestration.md), the [agent model](../architecture/agent-model.md), the [screen inventory](../design/screens-and-flows.md) and the This Quest lifetime of [ADR 015](015-approval-lifetimes-and-grants.md) for Slice 9 ([#10](https://github.com/otaviobarros/hobbots/issues/10)).

## Context

A hob should take on bigger work without losing you. Some work is long but stays with one hob. Other work needs several hobs, each with its own role. The orchestration contract already decides delegation, limits, cancellation and the completion gate, and the agent model already names Quest, Task, Delegation and Execution. Three things were still open: what the words mean on screen and in code, when work counts as a Quest, and how you follow and steer work that several hobs share.

Until now a Task belonged to a Quest. That made every piece of work look like a Quest, even when one hob did all of it.

## Decision

### The words

The word follows who works on it and how they coordinate, not how big the work is. Code, docs and UI use the same words.

| Word | Meaning |
|---|---|
| **Task** | One hob's piece of work, end to end: one owner, one result, even when it takes hours. |
| **Step** | A part of a Task that its own hob runs in a fresh session from a short brief. |
| **Quest** | A Task that brings in other hobs. |
| **Lead** | The hob that owns a Quest: the hob you asked. |
| **Party** | The other hobs working on a Quest, shown as "Aldric's party: Quill, Ada". |

### One record: the Task

Every piece of work is a Task with an owner, a brief, a state, checkpoints, a result and attempts. A Task can have child Tasks, so steps, a member's work and nested Quests are all Tasks in one tree.

- **Steps.** A Task whose children all have its owner is a Task with steps. A hob splits its own work into steps so a long job does not drown in one context. Each step runs in a fresh session from its brief and returns a checkpoint and its result, not its whole session, so the owner's conversation stays small. Splitting your own work into steps never makes a Task a Quest.
- **Quest.** A Task becomes a Quest when its owner first brings in another hob, by delegating to it or by starting a Quest explicitly. That adds a Quest record to the same Task. The Task keeps its id, its card and its history: no migration and no new screen. Its owner becomes the lead.
- **Party.** Each member works on its own Tasks under the Quest. The lead plans, briefs each member, waits on their results, hands results between them and wraps up in your chat.

Example: you ask Aldric, the chief of marketing, for a Black Friday campaign. Aldric writes the Quest's goal and splits it into Tasks: Quill drafts the copy, and Ada builds the campaign once the copy exists. Quill starts at once. Ada's Task depends on Quill's, so it stays queued and shows "waiting on Quill" until Quill's completes. Then Ada starts, with Quill's result and copy in her brief. Aldric reviews both results and posts one message in your chat with what was made and where it is.

### Rules

- **You talk only to the lead.** Everything you say about a Quest goes to the lead, who passes it on with its own context. A note you leave on a member's Task reaches the lead as a message about that Task. The drawer and the Quest tab still show everything a member does. Talking to a member directly is out of scope.
- **Controls act directly.** Cancel, Retry and Reassign act on a Task without going through the lead, under the orchestration contract's cancellation rules.
- **A member's approvals come straight to you.** When a member's tool call needs approval, it reaches you as on any other turn. A lead never approves on your behalf (PE-006).
- **Questions go up.** A member's question goes to its nearest lead, who answers it or escalates it. It reaches you only when no lead can answer, on the card and in the Inbox. Your answer goes back down the same chain to the hob that asked.
- **A dependent Task waits.** A Task delegated with `depends_on` starts no turn until every Task it depends on has completed, as a step does. If one of them fails or is cancelled, its lead hears of that, and the dependent stays queued, showing that it cannot start, until the failed Task is retried or reassigned and completes, or the dependent is cancelled.
- **Members never talk to each other.** A member whose Task depends on others starts with what each of them returned: its result and artifacts. Anything else moves from one member to another only as a hand-off through the lead.
- **Nested Quests.** A member can bring in a hob of its own and lead that subtree under the same rules. The lead of a subtree is the nearest lead for its own members.
- **Depth counts Quests, not steps.** A Quest is depth 1, and a member's own Quest inside it is depth 2. Steps never add depth. The limit is 2 by default and configurable, so Aldric → Rook → Pip fits and Pip cannot bring in another hob.

### Approvals for this Task or Quest

ADR 015's middle lifetime is bound to the work, not to the word. A grant saved with it is bound to the **top Task** of the request's tree: the Task you asked for, whether or not it has become a Quest.

- The card says **This Task** for a Task without a party and **This Quest** once a party joins. Both are the same lifetime.
- A Task that grows into a Quest keeps its id, so a grant given before the party joined still applies after.
- Steps are in the same tree, so one grant covers every step of the Task, even though each runs in a fresh session.
- A grant still belongs to one hob, and delegation never passes it on (PE-004). A party member asks for its own grant, bound to the same top Task, so it ends with the Quest.
- A delegation passes on only the answers someone gave on purpose: the lead's own override or restriction, a delegation above it, or the brief. Where the lead only follows the safety preset, which every hob shares, it passes on nothing, so the member's preset Ask can still be answered by its grant and its request can offer This Quest. An answer given on purpose stays a restriction even where it equals the member's preset, such as the lead's own push Ask under Balanced: no grant of the member's answers it, and it offers once only (ADR 015).
- The grant ends when the top Task ends, or when it is revoked.
- The Inbox groups requests by their top Task, named as a Task or a Quest. Requests outside any Task stay grouped by hob and thread.

### Checkpoints

A checkpoint is a short record of where a Task stands. It comes from one of three sources:

| Source | Kinds | Who records it |
|---|---|---|
| Planned | Milestones the lead sets in a brief, reported when reached | The Task's owner |
| Unplanned | Findings that may change the plan, blockers and questions, reported when the owner decides they matter | The Task's owner |
| Automatic | Started, waiting, done, failed and cancelled, and findings the hub makes itself | The hub |

Milestones, findings, blockers, questions, done and failed reach the lead's context and can wake it.

#### Two Tasks changing the same file

A party shares its lead's folders, and no Task owns a path, so one member can overwrite a file another member is still working on ([#570](https://github.com/otaviobarros/hobbots/issues/570)). Of the three ways to handle it (report it, narrow each member's folders, or let a Task claim paths that others must ask for), the hub reports it, the smallest:

- When a turn records a change to a file that another Task in the same tree, owned by another hob, also changed in its current Attempt, while both were at work, the hub records an automatic finding. Both were at work when the Task that changed the file first had not ended by the time of the other change. A turn often completes its Task before its last scan records what it changed, so that change still counts.
- The finding goes on the Task whose change was recorded last, or on the other one when that Task has already ended. It names the other Task too, so the Quest tab, the card and both drawers show it. If both Tasks have ended, nobody is left at work, and nothing is recorded.
- A finding that fails to record is tried again. When the hub starts, it looks over the changes already recorded in work still going on, so a finding it stopped before recording is recorded then.
- It reaches the nearest lead like any finding, once per pair of Tasks and file, however often their scans record the change. The lead decides which version stays.
- A file compares by its full path, so two folders, one inside the other, still match. A write that leaves a file's bytes as they were is not a change, so nothing reports it.
- Nothing is refused. Narrowing each member's folders by default is a separate change ([#582](https://github.com/otaviobarros/hobbots/issues/582)), and path claims stay open. Routine progress only updates the screens and never wakes the lead (IN-005), and it may be coalesced before it is journaled ([ADR 013](013-event-journal.md)).

### Records

Each record has a stable id and explicit lineage, and every change is written with its journal event in one transaction ([ADR 013](013-event-journal.md)).

| Record | Holds | Lineage |
|---|---|---|
| Task | Owner, parent, root, brief, state, dependencies, result, version | Parent Task and root Task; a step has its parent's owner |
| Quest | Goal, acceptance, limits, lead, party, state | The Task it was added to; the thread that started it, or for a nested Quest the Quest it sits in |
| Delegation | The brief from lead to member, narrowed authority, timeout | Lead, member, parent Task and child Task |
| Attempt | Runtime, session, configuration and policy versions, outcome | Task; a retry is a new Attempt, never a new Task, and a lead's later chat turns on its Task resume its current Attempt |
| Milestone | Title, order, when it was reached | Task whose brief or Quest planned it |
| Checkpoint | Source, kind (milestone, finding, blocker, question, progress or an automatic state), summary, and for a hub finding the other Task it is about | Task and Attempt |
| Question | Asker, current recipient, the escalation chain, answer | Task that asked it |
| Task note | What you said about a Task, and the lead it went to: the nearest one still at work | The Task it is about |
| Artifact reference | A file, link or text a Task made | Task and Attempt that produced it; a hand-off adds it to the receiving brief |

Attempt is the record the agent model also calls Execution. Approvals stay the records from [ADR 015](015-approval-lifetimes-and-grants.md).

| Event | Journaled when |
|---|---|
| `TaskCreated` | A Task, a step or a delegated Task is created, with its Delegation and Milestones |
| `TaskStateChanged` | A Task's state, owner or current Attempt changes, including cancel, retry and reassign |
| `QuestStarted` | A Task gains its Quest record |
| `CheckpointRecorded` | A Checkpoint is recorded, including a reached Milestone |
| `QuestionAsked`, `QuestionAnswered`, `QuestionEscalated`, `QuestionWithdrawn` | A Question is asked, answered, passed up, or withdrawn when its Task is cancelled or fails first |
| `NoteLeft` | You leave a note on a Task for its lead |
| `HandedOff` | The lead gives one Task's result to another as an Artifact reference |
| `TaskCompleted` | A Task passes the completion gate, with its result and Artifact references |
| `QuestCompleted` | The Task that holds a Quest passes the completion gate |

Approval events stay as they are. The journal lets every screen update live and replay after a reconnect.

### Hob tools

Hobs act through Hobbots tools on the runtime's control channel, as Charms are exposed. The server checks every call; the prose a hob writes decides nothing. These refine the tool list in the orchestration contract. A tool's name can change during implementation; what it does is decided.

| Tool | Who may call it | What it does | Stores |
|---|---|---|---|
| `plan_steps` | A Task's owner | Splits its own Task into steps, each with a brief | Child Tasks with the same owner |
| `start_quest` | A Task's owner | Turns its Task into a Quest with a goal, milestones and limits | Quest |
| `delegate_task` | A Task's owner, which becomes or already is its lead | Gives another hob a Task with a brief, milestones and dependencies; the first call makes the Task a Quest | Task, Delegation |
| `report_checkpoint` | A Task's owner | Reports a milestone, finding, blocker or progress | Checkpoint |
| `ask` | A Task's owner | Asks a question; the server routes it to the nearest lead | Question |
| `answer` | A lead | Answers a question from its subtree | The answer on the Question |
| `escalate` | A lead | Passes a question it cannot answer to the next lead, and from the top lead to you | The Question's new recipient |
| `hand_off` | A lead | Gives one Task's result to another Task as context | Artifact reference on the receiving brief |
| `wait_for` | A Task's owner | Waits for any or all of its child Tasks, steps or members' Tasks, without blocking its chat. The hob then ends its turn, and the Task shows as waiting once the turn has ended | Wait record |
| `read_tasks` | A Task's owner | Reads the state of every Task under its own, at any depth: owner, state, whether a turn runs, what it waits on, open questions, latest checkpoints and result | Nothing |
| `message_task` | A lead | Sends a short message to a member's Task directly under its own, which wakes the member; a hob further down is reached through its own lead | A note from the lead on that Task |
| `complete_task` | A Task's owner | Returns the result; the server checks the completion gate | Result, Task state |
| `cancel_task` | A Task's owner | Cancels one of its child Tasks and that Task's subtree | Cancel request, then confirmed outcomes |

On every call the server checks:

- **Who may call it:** the Task's owner, or a lead above it in the tree. A hob can never act on a Task outside its own subtree.
- **Depth:** a delegation past the depth limit is refused.
- **Concurrency and time limits:** per hob, per Quest and per runtime session, with Task deadlines, as the orchestration contract sets them.
- **No cycles:** a hob cannot be given a Task whose lineage it already leads.
- **Authority only narrows:** a child's permissions and limits are the intersection of its own and its parent's. A brief cannot widen them.
- **Idempotency:** each call carries a key, so a retried call returns the first result and never creates a second Task, Question or hand-off.
- **Refusals are recorded:** a refused call writes none of its records, but the refusal itself is kept and journaled, with its reason and message, and shows as a failed step in the reply and in the Workbench Summary ([#575](https://github.com/otaviobarros/hobbots/issues/575)). Its key stays free, so a retry is decided again; a refusal is never replayed as a result.

### What you can do

| Action | Effect |
|---|---|
| Leave a note on a Task | Goes to the lead as a message about that Task |
| Answer an escalated question | Goes back down the chain to the hob that asked |
| Approve or deny a member's tool call | Goes straight to that member |
| Cancel a Task or the Quest | Cancels with confirmed outcomes |
| Retry or Reassign, from the Quest tab | A new Attempt, or a new owner with history kept |

### Screens

- **The card under your request.** It is the Task card, and the Quest card once a party joins. A Task shows "Aldric is on it" with a progress line and its steps; a Quest adds the party's portraits. It shows at most four rows, ordered by needs you, blocked, running and waiting. Done rows collapse into a count, and Show all opens the drawer. A Task with steps shows only its current step and "step 3 of 7".
- **The strip under the chat header** keeps the work in view while you scroll, with portraits and counts, never rows.
- **The drawer** opens a Task or step: its brief, checkpoints and output.
- **The Quest tab** is the control room: the full tree with Retry, Reassign, Cancel Task and Cancel Quest.
- **Party members** show "On Aldric's quest" on Home and in their hob panel, linking to the Quest. A member's work never shows as a separate chat thread.
- **The chat** only gets the moments that matter: questions that reach you, approvals and the lead's wrap-up.

## Rationale

Naming work by who does it keeps the words stable: a long Task is still a Task, and a short request that needs two hobs is a Quest. One Task record for steps, members' work and nested Quests means one tree, one set of limits, one completion gate and one way to cancel. Adding the Quest record to the existing Task, instead of creating a new object, lets work grow without moving you to a new screen or losing its history.

Routing everything you say through the lead keeps one conversation and one hob responsible for the plan. Controls and approvals skip the lead because they are your authority, not the lead's: a lead that could approve or block your Cancel would hold power a hob must never have. Questions climb because the lead usually has the context to answer, and you only want the decisions that are truly yours. Hand-offs through the lead keep members' work reviewable and stop members from steering each other.

Checking every rule in the server, not in the prompt, is what makes a recursive delegation loop or a widened brief fail safely.

## Consequences

- The agent model changes: a Task no longer has to belong to a Quest, and a Quest sits on the Task it was added to. Milestone, Checkpoint, Question and Artifact reference are new records.
- The orchestration contract's tool list becomes the table above. `send_agent_message` reaches only between a lead and its own members, for example to pass on your note; members never message each other. `list_tasks`, `get_task` and `get_quest_status` stay as read tools, scoped to the caller's subtree.
- ADR 015's grant table binds This Quest grants to the top Task instead of a Quest, and the approval card offers the lifetime from Slice 9 on.
- The depth limit default is 2. Concurrency, per-hob active Task and timeout defaults stay open and configurable.
- The chat gets a card, a strip and a drawer; the Quest tab becomes the control room; Home and the hob panel show a member's Quest work.
- Continuation after a turn ends is decided in [ADR 019](019-hob-backpack-and-continuations.md) for Slice 10: results, questions and hand-offs reach the lead through its backpack, and one dispatcher wakes it. Different runtimes in one Quest (Slice 11) are out of scope.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- Records keep lineage and their invariants, and each change is journaled with its event: `[TC-OR-001]`, `[TC-OR-002]`, `[TC-OR-003]`, `[TC-OR-004]`, `[TC-OR-005]`, `[TC-OR-008]`, `[TC-OR-009]`, `[TC-EX-016]`, on SQLite and PostgreSQL. A Task tree and a Quest read with a cursor the event stream resumes from: `[TC-OR-006]`.
- Each hob tool is refused for a caller outside its subtree, past the depth limit, in a cycle or with wider authority, and a retried call is idempotent: `[TC-OR-010]` to `[TC-OR-020]` and `[TC-OR-024]`, at hub level with the fake runtime on SQLite and PostgreSQL ([#271](https://github.com/otaviobarros/hobbots/issues/271)). Serving the tools to a real Claude Code is not verified yet. Every refusal is recorded once per hob and key, journaled and announced, whatever refused it, and its key is never replayed as done: redacted first, and a chat turn's refusal is kept on the Task it works on: `[TC-OR-300]` to `[TC-OR-305]`, `[TC-OR-307]`, `[TC-OR-308]`, on SQLite and PostgreSQL; the refused call shows as a failed step in the reply and in the Workbench Summary: `[TC-OR-306]`, in the browser ([#575](https://github.com/otaviobarros/hobbots/issues/575)).
- Aldric splits a long Task into steps; the card shows "step 2 of 4" and he keeps only checkpoints, not each step's session: `[TC-OR-025]` to `[TC-OR-039]`, at hub level with the fake runtime on SQLite and PostgreSQL, and the card in the browser on SQLite: `[TC-OR-034]` ([#272](https://github.com/otaviobarros/hobbots/issues/272)). Real Claude Code is not verified. A step works from the whole result and artifacts of each step it comes after, while the owner's briefing keeps them short, within a limit for each and for all of them: `[TC-OR-060]`, `[TC-OR-061]` ([#332](https://github.com/otaviobarros/hobbots/issues/332)).
- Aldric leads a Quest with Quill and Ada; Ada's Task waits for Quill's to complete, and his copy reaches her through Aldric, and Aldric wraps up in your chat while you can still talk to him: `[TC-OR-090]`. A member whose turn leaves its milestones unreported is blocked and its lead hears of it: `[TC-OR-091]`; one retired while it works fails with a blocker its lead hears of: `[TC-OR-092]`. A member works under its own policy narrowed by the delegation, reaches only the folders it gives, and its Ask reaches you, never its lead: `[TC-PE-160]`, `[TC-PE-161]`, `[TC-PE-162]`; the steps it plans work under the same narrowing: `[TC-PE-163]`. In the browser, its request waits in the Inbox under its lead's thread and opens that chat: `[TC-IN-062]`. All at hub level with the fake runtime on SQLite and PostgreSQL ([#273](https://github.com/otaviobarros/hobbots/issues/273)). Real Claude Code is not verified.
- Quill's question is answered by Aldric without reaching you, and Quill goes on with the answer in his own session: `[TC-OR-130]`. Ada's question that Aldric passes up reaches you, and your answer gets back to her: `[TC-OR-131]`, and it waits for you with its Task until you answer: `[TC-OR-134]`. Your note on Quill's Task reaches Aldric once as a message about that Task, however often it is sent, and never once the work has ended: `[TC-OR-132]`, `[TC-OR-135]`, `[TC-OR-136]`, `[TC-PE-220]`, `[TC-IN-130]`; it skips a lead whose own Task ended, and a question about ended work stops waiting for you: `[TC-OR-137]`. A question whose Task is cancelled or fails before anyone answers it is withdrawn, so its lead can still complete and its lead's copy resolves as late: `[TC-OR-167]`, `[TC-OR-168]`; questions left open on Tasks that ended earlier are withdrawn by a migration, with their leads' pending copies resolved as late: `[TC-OR-169]`. In the browser, cancelling Ada's Task while her question waits for you withdraws it from the Inbox, the chat's card and the drawer, also after a reload, and Aldric still wraps up: `[TC-IN-154]` ([#368](https://github.com/otaviobarros/hobbots/issues/368)). A finding wakes Aldric with the routine progress folded in, and the progress alone never does: `[TC-OR-133]`; a lead's continuation says how to answer or pass a question up, and who answered: `[TC-IN-131]`; a note on a lead's own step, running or done, reaches the chat that coordinates the work: `[TC-IN-135]`. All at hub level with the fake runtime on SQLite and PostgreSQL. In the browser, the question waits in the Inbox's Needs you and your answer there reaches the chat: `[TC-IN-132]`, and stays in step with events while the list is read: `[TC-IN-133]`, `[TC-IN-134]`, and the drawer's note goes to the lead: `[TC-OR-013]` ([#274](https://github.com/otaviobarros/hobbots/issues/274)). Real Claude Code is not verified.
- Rook brings in Pip under Aldric's Quest and leads her: her Task sits under his, his Quest is depth 2, her result reaches his session and never Aldric's, and the Quest ends when all three are done: `[TC-OR-160]`. A delegation loop is stopped by the checks every call already passes, with nothing written: past the depth limit as `depth-limit`, back to any hob above as `cycle`: `[TC-OR-161]`; with the limit raised to 3, the cycle check stops every way back up and the new limit stops the next level: `[TC-OR-162]`. Pip's question reaches Rook first, climbs to Aldric and then to you, and your answer goes back to her: `[TC-OR-163]`. Cancelling the Quest confirms every Task on every level and starts nothing after: `[TC-OR-164]`; cancelling Rook's Task cancels Pip's under it and leaves Aldric's Quest going, and neither changes hands across levels: `[TC-OR-165]`. All at hub level with the fake runtime on SQLite and PostgreSQL. In the browser, the Black Friday Quest played with Rook and Pip shows Pip's Task under Rook's, indented one level further, and Rook's row reads "Leads Pip": `[TC-CH-191]` ([#275](https://github.com/otaviobarros/hobbots/issues/275)). Real Claude Code is not verified ([evidence](../evidence/2026-11-02-nested-quests.md)).
- Two members that change the same file while both are at work give their lead one finding, on the Task that changed it last and naming the other Task and the file, however often it is recorded; full paths match across folders, and nothing is found for other files or once the other Task has ended: `[TC-OR-280]`, `[TC-OR-281]`, `[TC-OR-282]`, at hub level on SQLite and PostgreSQL. In the browser, both members' rows in the Quest tab say whose Task changed the same file, and both drawers show the finding: `[TC-OR-283]`, with the fake runtime ([#570](https://github.com/otaviobarros/hobbots/issues/570)). A member whose turn completes its Task before the turn's last scan records the change still gives the finding, on the Task still at work, through the hub's recorder and `complete_task`: `[TC-OR-289]`. Changes recorded before the hub stopped, with no finding yet, give it once the hub starts again, and only once: `[TC-OR-290]`. Both run at hub level on SQLite and PostgreSQL. Real Claude Code is not verified.
- A This Task grant covers every step of the Task, still applies after the Task becomes a Quest, is never used by another hob, and ends with the top Task: `[TC-PE-248]`, `[TC-PE-249]`, `[TC-PE-259]`, at hub level with the fake runtime on SQLite and PostgreSQL. A member's own request offers it too, while an Ask its delegation narrowed offers none: `[TC-PE-260]`, and an Ask the lead set on purpose is never answered by the member's own grant: `[TC-PE-261]`. In the browser, the card says This Task in the chat and This Quest for a member's request in the Inbox: `[TC-IN-152]`, `[TC-IN-153]` ([#352](https://github.com/otaviobarros/hobbots/issues/352)). Real Claude Code is not verified.
- Cancelling the Quest ends with every Task confirmed or explicitly unresolved, and starts nothing after: `[TC-OR-143]`, `[TC-OR-145]`; cancelling the Task you asked for waits for a later reply working on it to stop, or leaves it unresolved, and that reply starts nothing in its place: `[TC-OR-150]`, `[TC-OR-154]`; a member's Task that waits with no turn running is confirmed and its lead hears of it: `[TC-OR-144]`; a late result from a cancelled Task changes nothing: `[TC-OR-146]`, `[TC-IN-140]`. Retry adds an Attempt of the same Task: `[TC-OR-140]`, `[TC-OR-147]`, while a lead's later chat turns, continuations included, resume its current Attempt and keep each turn's Workbench records: `[TC-OR-310]` to `[TC-OR-319]` ([#577](https://github.com/otaviobarros/hobbots/issues/577)); Reassign keeps history and is refused where it would break the tree: `[TC-OR-142]`, `[TC-OR-148]`, `[TC-OR-149]`, `[TC-IN-141]`, and a hob a Task comes back to starts afresh: `[TC-OR-151]`; nothing starts under a Task being cancelled: `[TC-OR-141]`; only you use them: `[TC-PE-230]`. At repository level on SQLite and PostgreSQL and at hub level with the fake runtime ([#276](https://github.com/otaviobarros/hobbots/issues/276)). Real Claude Code is not verified. Cancelling the Quest while its lead's continuation reads a member's result leaves nothing waiting in any backpack once its Tasks have stopped, routine progress included: `[TC-OR-180]`, `[TC-OR-184]`, at hub level with the fake runtime on SQLite and PostgreSQL ([#396](https://github.com/otaviobarros/hobbots/issues/396)).
- A Task delegated with `depends_on` starts no turn until every Task it depends on has completed, then starts exactly one: `[TC-OR-200]`, also when it depends on two that complete apart: `[TC-OR-203]`. One whose dependency fails stays queued, its lead's briefing says it cannot start, and it starts once that Task is reassigned and completes: `[TC-OR-201]`; one whose dependency is cancelled stays queued until it is cancelled too: `[TC-OR-202]`. All at hub level with the fake runtime on SQLite and PostgreSQL. In the browser, the Quest tab shows it as Waiting, waiting on the hob it depends on, and Running only once that Task is done: `[TC-OR-204]` ([#564](https://github.com/otaviobarros/hobbots/issues/564)). Real Claude Code is not verified.
- A dependent's first prompt carries the result and artifacts of every Task it depends on, within the step input limits: `[TC-OR-205]`, `[TC-OR-206]`, as unit tests. Aldric waits on Rook, Quill's completion starts Rook's one turn with Quill's result and no hand-off, and the Quest finishes from your one message: `[TC-OR-207]`; a hub that stops between Quill's completion and Rook's start loses nothing and starts Rook once: `[TC-OR-208]`, at hub level with the fake runtime on SQLite and PostgreSQL. In the browser, a three-member Quest with a dependency chain runs to finished with no action of yours: `[TC-OR-209]` ([#565](https://github.com/otaviobarros/hobbots/issues/565)). Real Claude Code is not verified.
- The card, strip and drawer show the work as decided, and the Black Friday Quest can be followed end to end from the lead's chat, live from the journal: `[TC-OR-010]`, `[TC-OR-011]`, `[TC-OR-012]`, `[TC-OR-013]`.
- The Quest tab shows the whole tree live with owner, state, age and who is waited on, nested Quests indented, its controls where they apply, and a pinned Quest in every thread: `[TC-CH-190]`. Its controls act on the Task directly and show what the hub recorded: Cancel Quest reads as cancelling until every Task confirms it stopped, a Reassign offers only the hobs the hub would accept, and a refusal says why in the tab: `[TC-CH-193]`; Cancel Task confirms one Task, Retry starts a new Attempt of a failed Task and Reassign gives a member's failed Task to another hob with the party following, each live: `[TC-CH-192]`, in the browser; the fake Black Friday Quest these follow stops only the member's Task you cancel and plays the rest: `[TC-OR-166]`, with the fake runtime ([#311](https://github.com/otaviobarros/hobbots/issues/311)).
- A lead that waits is told to end its turn, the same wait again in that turn records nothing, and its Task stays active until the turn ends and waits after it: `[TC-OR-240]`, `[TC-OR-241]`, at hub level on SQLite and PostgreSQL; in the browser, the Quest tab shows the lead Running during that turn and Waiting after it: `[TC-OR-242]` ([#572](https://github.com/otaviobarros/hobbots/issues/572)). Real Claude Code is not verified.
- A lead that waits reads in `wait_for`'s result the questions and blockers the awaited Tasks have open, and is told to answer first: `[TC-OR-243]`; a question from an awaited Task reaches the lead in the first turn after the one that waited, and is answered once: `[TC-OR-244]`, at hub level on SQLite and PostgreSQL; in the browser, the question is carried into the lead's turn and handled, never held: `[TC-OR-245]` ([#573](https://github.com/otaviobarros/hobbots/issues/573)). Real Claude Code is not verified.
- A member whose turn ends leaving a Quest it leads with nobody brought in and nothing to wait on reports one finding, which reaches its lead: `[TC-OR-246]`, at hub level on SQLite and PostgreSQL; the guards that keep a root Task, an ended or missing Quest, a party, a wait or an earlier report from reporting it: `[TC-OR-256]` to `[TC-OR-258]`, unit; the Quest tab says "No one brought in yet" under that member's row: `[TC-OR-247]` ([#576](https://github.com/otaviobarros/hobbots/issues/576)). Real Claude Code is not verified.
- A lead reads every Task under its own, at any depth, and is refused above or beside it: `[TC-OR-248]`; its message reaches a member directly under it once, however often it is retried, is fenced by claims like every other call, and never skips a level: `[TC-OR-249]`, `[TC-IN-166]`; once the obstacle clears, Frodo's message reaches Pip, Pip's reaches Nettle, and the nested Quest completes with no cancel: `[TC-OR-250]`. All at hub level on SQLite and PostgreSQL. In the browser, the lead's message wakes the blocked member, which finishes with nothing cancelled: `[TC-OR-251]` ([#574](https://github.com/otaviobarros/hobbots/issues/574)). Real Claude Code is not verified.
- A party member's work shows "On Aldric's quest" with its Task's state on Home and in its panel, opens the Quest, and is never one of its threads: `[TC-UX-020]`. A hob's work on other hobs' Quests reads with a cursor and stays listed until its Quest ends, with the hob whose thread follows a nested Quest: `[TC-OR-021]`, `[TC-OR-022]`, `[TC-OR-023]`.
- The whole slice runs end to end from one request: Aldric's steps, a party with a hand-off through him, a question he answers and one he passes up to you, and a nested Quest whose loop the limits stop: `[TC-OR-170]`. In one Quest, Retry and Reassign finish what failed, Cancel Task stops a nested lead and its member, and Cancel Quest confirms the rest: `[TC-OR-171]`. A hub that stops mid-Quest starts again with nothing lost or duplicated: `[TC-OR-172]`, and a This Task grant holds across the restart and ends with the Quest: `[TC-PE-263]`. All at hub level with the fake runtime on SQLite and PostgreSQL ([#280](https://github.com/otaviobarros/hobbots/issues/280), [evidence](../evidence/2026-11-02-tasks-and-quests-end-to-end.md)). Real Claude Code is not verified.

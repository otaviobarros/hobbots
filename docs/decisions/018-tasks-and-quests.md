# ADR 018 — Tasks and Quests

Status: **Accepted.** Its screens are amended by [ADR 027](027-quest-room.md): the card, the strip's drawer, the quest and task sheets and the Quest tab give way to the Quest room. Refines [orchestration](../architecture/orchestration.md), the [agent model](../architecture/agent-model.md), the screen inventory and the This Quest lifetime of [ADR 015](015-approval-lifetimes-and-grants.md) for Slice 9 ([#10](https://github.com/otaviobarros/hobbots/issues/10)).

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

- **You talk only to the lead.** Everything you say about a Quest goes to the lead, who passes it on with its own context. A note you leave on a member's Task reaches the lead as a message about that Task. The Quest room shows everything a member does, in its lane ([ADR 027](027-quest-room.md)). Talking to a member directly is out of scope.
- **Controls act directly.** Cancel, Retry and Reassign act on a Task without going through the lead, under the orchestration contract's cancellation rules.
- **A member's approvals come straight to you.** When a member's tool call needs approval, it reaches you as on any other turn. A lead never approves on your behalf (PE-006).
- **Questions go up.** A member's question goes to its nearest lead, who answers it or escalates it. It reaches you only when no lead can answer, in the asking hob's lane in the Quest room, in the chat and in the Inbox. Your answer goes back down the same chain to the hob that asked.
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
- The finding goes on the Task whose change was recorded last, or on the other one when that Task has already ended. It names the other Task too, so the Quest room shows it in both lanes. If both Tasks have ended, nobody is left at work, and nothing is recorded.
- A finding that fails to record is tried again. When the hub starts, it looks over the changes already recorded in work still going on, so a finding it stopped before recording is recorded then.
- It reaches the nearest lead like any finding, once per pair of Tasks and file, however often their scans record the change. The lead decides which version stays.
- A file compares by its full path, so two folders, one inside the other, still match. A write that leaves a file's bytes as they were is not a change, so nothing reports it.
- Nothing is refused. Each member's folders are narrowed by default (see below), and path claims stay open.

#### Work left uncommitted

The completion gate checks the responsibility ledger, not the workspace, so a Task could complete with files it changed in a Git repository still uncommitted ([#586](https://github.com/otaviobarros/hobbots/issues/586)).

- When `complete_task` succeeds, the hub compares the files the Task's Attempts changed, as the Workbench recorded them, with their repository's last commit. A file tool's change is scanned a moment after the call ends, so the live turn's pending scan is recorded first. A file that is staged, unstaged, new or deleted counts. The hub reads the repository's files itself and runs no Git command, hook or filter. A linked worktree is read with its own HEAD and index, and the branches and objects it shares with its main repository.
- Anything left uncommitted is a warning in the tool's answer, except on the top Task of a Quest (below). The Task also keeps an automatic `uncommitted` checkpoint, which the Task's lane in the Quest room shows and which reaches the lead.
- The top Task of a Quest is held on what it leaves uncommitted, since its result is the user's: `complete_task` is refused with `uncommitted-changes`, naming the files, until its lead commits them or calls again with `leave_uncommitted` saying why. That reason is kept in the Task's `uncommitted` checkpoint, which its Summary shows under Still open. Every other Task only warns its hob ([#665](https://github.com/otaviobarros/hobbots/issues/665)).
- A hob without its own GitHub App commits as the user. Its commands get the user's configured email below any setting of the repository's own. No name is given: Git takes it from config, the repository's own `user.name` or else the user's global one, which the sandbox opens for reading. Git has no place for a name below a repository's config that a command's environment can reach (Claude Code's scrub removes `GIT_CONFIG_GLOBAL`), and `GIT_AUTHOR_NAME` or a command-level `user.name` would override every repository's own, however deep. So each field is settled by the repository the commit lands in: one that sets both keeps both, one that sets only an email gets the user's name with its own email. Where neither sets a name, as when the user's config stays closed because a file looks like it holds a secret, Git takes the account's full name, and fails when that is empty. With no email configured, Git is told to take an identity from config only, so a commit fails instead of using a name made up from the computer's.
- With no email configured, the hub settles who hobs commit as, never the hob ([#741](https://github.com/otaviobarros/hobbots/issues/741)). A hob cannot apply an answer, since it may set no identity itself ([#700](https://github.com/otaviobarros/hobbots/issues/700)), so asking it to ask only goes round in circles. When a turn of a hob on the user's account starts with commands open, the hub raises one question of its own ([#976](https://github.com/otaviobarros/hobbots/issues/976)), in the chat the work was asked in, which for a Quest's members and steps is the Quest's chat. With the hub's GitHub account connected, hobs commit as it at its noreply address without asking, and the hub keeps it. Otherwise the question asks, once per hob and in plain words, whether the hob will write code ([#1241](https://github.com/otaviobarros/hobbots/issues/1241)): Set up GitHub leads to the hob's Charms tab, where it can get its own GitHub App, and the user can say not for this hob or not for any hob, which Settings clears. The hub sends the hob's name for data and the two choices as the keys `not-this-hob` and `no-hob`, applies a pick by its key, and leaves the words to the client ([#1045](https://github.com/otaviobarros/hobbots/issues/1045)). An identity the user typed before #1241 is kept. Until one applies, the hob is told not to commit, not to ask for a name and email, to leave its changes uncommitted, and to tell the user in plain words where to set up GitHub. From the next turn, on every runtime, its commands get that email below every config, and, where the user's config sets no name either, its name as a command-level `user.name`. That name is the one exception to the rule above: it wins over a repository's own name, because Git has no lower place for it, and it applies only to a user with no Git name at all. A session keeps the system prompt it started with, so every resumed turn's prompt says again who it commits as now. The hub settles who a turn commits as before the turn starts (`CommitsAs` on the turn's tool access: the hob's bot, the user's config, the identity they gave, or no one yet), and a runtime applies it as given through one shared helper, never reading the user's Git config itself; each supported runtime, and any added later, passes one contract test for it.
- Each hob commits its own Task's work, as itself, and never another hob's ([#742](https://github.com/otaviobarros/hobbots/issues/742)). Every brief that can commit, a lead's briefing, a member's prompt and a step's, says so up front: run plain `git commit`, since the hub sets who commits and no hob can set or change it; never ask another hob who to commit as, since none can answer and the hub asks the user itself. A lead's `git commit` is held while a Task under its own, owned by another hob, has not ended and has changes it made still uncommitted in the repository the command commits in, even when that Task is blocked. The command's folder is read after any `cd`, `git -C` or wrapper such as `env -C`, and the hub compares repositories by the real path of their top folder, so `..` or a link never hides one and a repository nested in another is its own: the hub refuses it before the policy decides it, naming the member, its Task and the files, so a lead never commits a member's work under its own identity. A step of the lead's own Task is held the same way. Commits in other repositories, and any commit once the member's changes are committed or its Task has ended, run as usual. Each runtime takes the hold from the turn's hub tools (`holdsCommit`), so Claude Code, Codex and any runtime added later refuse alike.

Routine progress only updates the screens and never wakes the lead (IN-005), and it may be coalesced before it is journaled ([ADR 013](013-event-journal.md)).

#### The folders a member gets

A lead that named no folders gave its member every folder it could reach, unrelated repositories among them ([#582](https://github.com/otaviobarros/hobbots/issues/582)). Now the member gets the narrowest folders the work needs:

- With `authority.folders` left out, the member gets the folders its brief names that are the lead's or inside one, as the hub stores them. A path in quotes is read to its closing quote on the same line, so a folder with a space in its name is named whole; any other path ends at the first space. The brief is read in one pass, whatever its length or shape (STD-SEC-005). If the brief names none, it gets the folder the lead's own Task works in, the first of the lead's folders, where its turns start.
- `"all"` gives every folder the lead has on the Task, as leaving it out used to. A list still has to be within the lead's folders, or it is refused.
- The member also keeps only the folders its own policy reaches, so a folder of the lead's own, or a shared folder the member hides, drops out of the list. That is why one member's list can differ from another's under the same lead. Each member's lane in the Quest room shows its folders, so a difference shows.

### Records

Each record has a stable id and explicit lineage, and every change is written with its journal event in one transaction ([ADR 013](013-event-journal.md)).

| Record | Holds | Lineage |
|---|---|---|
| Task | Owner, parent, root, brief, state, dependencies, result, version | Parent Task and root Task; a step has its parent's owner |
| Quest | Goal, acceptance, limits, lead, party, state | The Task it was added to; the thread that started it, or for a nested Quest the Quest it sits in |
| Delegation | The brief from lead to member, narrowed authority, timeout | Lead, member, parent Task and child Task |
| Attempt | Runtime, session, configuration and policy versions, outcome | Task; a retry is a new Attempt, never a new Task, and the later turns of a lead or a member on its Task resume its current Attempt |
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
| `NotePickedUp` | A turn of a note's recipient picks the note up ([#900](https://github.com/otaviobarros/hobbots/issues/900)) |
| `HandedOff` | The lead gives one Task's result to another as an Artifact reference |
| `TaskCompleted` | A Task passes the completion gate, with its result and Artifact references |
| `QuestCompleted` | The Task that holds a Quest passes the completion gate |

Approval events stay as they are. The journal lets every screen update live and replay after a reconnect.

### Hob tools

Hobs act through Hobbots tools on the runtime's control channel, as Charms are exposed. The server checks every call; the prose a hob writes decides nothing. These refine the tool list in the orchestration contract. A tool's name can change during implementation; what it does is decided.

| Tool | Who may call it | What it does | Stores |
|---|---|---|---|
| `plan_steps` | A Task's owner | Splits its own Task into steps, each with a brief | Child Tasks with the same owner |
| `start_quest` | A Task's owner | Turns its Task into a Quest with a goal, milestones, limits and the folders its work is in | Quest |
| `delegate_task` | A Task's owner, which becomes or already is its lead | Gives another hob a Task with a brief, milestones and dependencies; the first call makes the Task a Quest. Its answer lists the tools the member's session will be offered and those it will not, and `check: true` answers that alone ([ADR 014](014-tool-policy-and-enforcement.md#amendment-what-a-delegation-tells-its-lead-1348)) | Task, Delegation; none with `check` |
| `report_checkpoint` | A Task's owner | Reports a milestone, finding, blocker or progress | Checkpoint |
| `ask` | A Task's owner | Asks a question, optionally with two to four choices and the one it recommends; the server routes it to the nearest lead | Question |
| `answer` | A lead | Answers a question from its subtree; an answer that names a choice picks it | The answer on the Question |
| `escalate` | A lead | Passes a question it cannot answer to the next lead, and from the top lead to you | The Question's new recipient |
| `hand_off` | A lead | Gives one Task's result to another Task as context | Artifact reference on the receiving brief |
| `wait_for` | A Task's owner | Waits for any or all of its child Tasks, steps or members' Tasks, without blocking its chat. The hob then ends its turn, and the Task shows as waiting once the turn has ended | Wait record |
| `read_tasks` | A Task's owner | Reads the state of every Task under its own, at any depth: owner, state, whether a turn runs, what it waits on, open questions, latest checkpoints and result. The results and failures it shows count as read for the turn's completion | Nothing |
| `message_task` | A lead | Sends a short message to a member's Task directly under its own, which wakes the member; a hob further down is reached through its own lead | A note from the lead on that Task |
| `retry_task` | A lead | Queues a failed member's Task directly under its own again, with its reason and the revision it read (see the #1446 amendment below) | The Task queued again, and the lead's note |
| `reassign_task` | A lead | Gives a member's Task directly under its own to another hob, with its reason and the revision it read, under authority worked out again for that hob | The Task queued for its new hob, and the lead's note |
| `complete_task` | A Task's owner | Returns the result; the server checks the completion gate | Result, Task state |
| `cancel_task` | A Task's owner | Cancels one of its child Tasks and that Task's subtree | Cancel request, then confirmed outcomes |
| `stop_quest` | The lead of the Quest you asked for, only when you asked it to stop | Stops the Quest without delivering it, with a reason and a summary, and cancels everything under it (see the amendment below) | The Quest's stop, then confirmed outcomes |

On every call the server checks:

- **Who may call it:** the Task's owner, or a lead above it in the tree. A hob can never act on a Task outside its own subtree.
- **Depth:** a delegation past the depth limit is refused.
- **Concurrency and time limits:** per hob, per Quest and per runtime session, with Task deadlines, as the orchestration contract sets them.
- **No cycles:** a hob cannot be given a Task whose lineage it already leads.
- **Authority only narrows:** a child's permissions and limits are the intersection of its own and its parent's. A brief cannot widen them.
- **Idempotency:** each call carries a key, so a retried call returns the first result and never creates a second Task, Question or hand-off.
- **Refusals are recorded:** a refused call writes none of its records, but the refusal itself is kept and journaled, with its reason and message, and shows as a failed step in the reply and in the hob's lane ([#575](https://github.com/otaviobarros/hobbots/issues/575)). Its key stays free, so a retry is decided again; a refusal is never replayed as a result.

### What you can do

| Action | Effect |
|---|---|
| Leave a note on a Task | Goes to the lead as a message about that Task |
| Answer an escalated question | Goes back down the chain to the hob that asked |
| Approve or deny a member's tool call | Goes straight to that member |
| Cancel a Task or the Quest | Cancels with confirmed outcomes |
| Retry or Reassign, from the Task's lane in the Quest room | A new Attempt, or a new owner with history kept |

### Screens

[ADR 027](027-quest-room.md) replaces the screens this ADR first decided: the Task and Quest card, the drawer, the quest and task sheets and the Quest tab's control room. In short:

- **A ticket under your request** names the Quest, its party and its progress, and opens the Quest room. Every Task opens a room, with one lane until a party joins.
- **The Quest room** opens beside the chat: a lane per hob with its checkpoints, actions, hand-offs, questions and controls, one Workbench for the whole Quest docked under the lanes, and the thread as a column on the right.
- **Party members** show "On Aldric's quest" on Home and in their hob panel, linking to the Quest. A member's work never shows as a separate chat thread.
- **The chat** only gets the moments that matter: the lead's plan, a question no lead can answer, approvals and the finish.
- **A hob's History** is read from these records and the approval requests, never from the journal, which may drop entries older than 7 days once it holds more than the latest 10,000 ([ADR 013](013-event-journal.md)). It adds no record of its own. It shows the Tasks you asked the hob for, the Tasks its leads gave it, when each ended, the Quests it led, its approval requests and the questions that reached you. A lead's History adds its party's Tasks and their requests. Steps are left out, since their work shows on the Task they serve. Each event is the record as it is now: a failed Task that is retried leaves History until it ends again. The hub pages it by whole days in the reader's time zone.

## Rationale

Naming work by who does it keeps the words stable: a long Task is still a Task, and a short request that needs two hobs is a Quest. One Task record for steps, members' work and nested Quests means one tree, one set of limits, one completion gate and one way to cancel. Adding the Quest record to the existing Task, instead of creating a new object, lets work grow without moving you to a new screen or losing its history.

Routing everything you say through the lead keeps one conversation and one hob responsible for the plan. Controls and approvals skip the lead because they are your authority, not the lead's: a lead that could approve or block your Cancel would hold power a hob must never have. Questions climb because the lead usually has the context to answer, and you only want the decisions that are truly yours. Hand-offs through the lead keep members' work reviewable and stop members from steering each other.

Checking every rule in the server, not in the prompt, is what makes a recursive delegation loop or a widened brief fail safely.

## Consequences

- The agent model changes: a Task no longer has to belong to a Quest, and a Quest sits on the Task it was added to. Milestone, Checkpoint, Question and Artifact reference are new records.
- The orchestration contract's tool list becomes the table above. `send_agent_message` reaches only between a lead and its own members, for example to pass on your note; members never message each other. `list_tasks`, `get_task` and `get_quest_status` stay as read tools, scoped to the caller's subtree.
- ADR 015's grant table binds This Quest grants to the top Task instead of a Quest, and the approval card offers the lifetime from Slice 9 on.
- The depth limit default is 2. Concurrency, per-hob active Task and timeout defaults stay open and configurable.
- The chat gets a card, a strip and a drawer; the Quest tab becomes the control room; Home and the hob panel show a member's Quest work. [ADR 027](027-quest-room.md) later replaces the card, the drawer, the sheets and the control room with the Quest room.
- Continuation after a turn ends is decided in [ADR 019](019-hob-backpack-and-continuations.md) for Slice 10: results, questions and hand-offs reach the lead through its backpack, and one dispatcher wakes it. Different runtimes in one Quest (Slice 11) are out of scope.

## Amendment: a lead stops its Quest at your request ([#1346](https://github.com/otaviobarros/hobbots/issues/1346))

A Quest could end only as completed, failed or cancelled. Its lead could finish it only by saying it delivered, and `cancel_task` never reaches the Quest's own Task, so a lead you told to stop could not, and the hub went on waking it about an idle Quest. A Quest now has a fourth way to end.

- **Stopped is its own outcome.** `stop_quest` ends the Quest you asked for as `stopped`, never `completed`, with the lead's reason and a short summary of what was and was not done. It is not your Cancel either: you cancel from the Quest room, and the lead stops only when you asked it to. The Quest's lifecycle is now one machine, [`QuestMachine`](../architecture/machines/quest.md): `active`, then `stopping` while the work under it is cancelled, then `stopped` once its Task's cancel is confirmed. The stop is journaled as `QuestStopRequested`, and the end as the Task's `TaskStateChanged`, as before.
- **Only at your request.** The hub allows the call only from a turn that answers a message of yours in the Quest's chat, or that carries your answer to a question the lead asked. A turn woken by a member's report, a note or a finding is refused (`stop-not-asked`), with what to do instead: ask you. A member that leads a Quest under yours cannot stop yours (`not-a-quest`). The hub checks the call, so the rule holds on every runtime.
- **Everything under it is cancelled.** As Cancel Quest does, each open Task under it is cancelled with confirmed outcomes, and named as cancelled by the lead. The lead's own turn is not stopped: it ends on its own with its reply to you, so its stop is never left unresolved. Once that turn and everything under it have ended, the Task is cancelled and the Quest ends stopped. A turn of the lead that goes on is refused any more work on it.
- **Nothing wakes the lead about it.** A stopping or stopped Quest is never idle, so no "Nobody is working on this Quest" finding wakes its lead.
- **What you see.** The quest's sheet shows "Stopped at your request" with the summary and the reason, never "Quest finished", and the ticket under your request reads "Stopped at your request after …". The ticket stays one line ([ADR 027](027-quest-room.md)), so the summary is in the sheet and in the lead's reply.

## Amendment: a Quest's acceptance criteria are checked against evidence ([#1445](https://github.com/otaviobarros/hobbots/issues/1445))

A Quest's acceptance was strings folded into its brief and never read again, and `delivered: true` was its lead's own word. Each condition is now a criterion the hub holds the Quest to.

- **Criteria have ids.** Each line of `start_quest`'s `acceptance` is a criterion with an id, required unless the lead marks it optional. `delegate_task` links a member's Task to the criteria it works towards. Quests stored before keep one required criterion per line.
- **Checked against evidence.** The lead accepts a criterion with `check_criterion`, naming the artifacts that prove it: a result a Task in the Quest returned, or a file one made or changed. The hub ties each to that artifact's version in the registry ([ADR 037](037-chat-and-camps.md)). A newer version voids the evidence, in the transaction that registers it, and the criterion is open again. The lead can also send one back for rework. Each change keeps who decided, why and when, and is journaled as `QuestCriteriaChanged`. [`CriterionMachine`](../architecture/machines/criterion.md) holds the states. The lead reads each criterion's id again from the records in any session ([#1555](https://github.com/otaviobarros/hobbots/issues/1555)): its briefing lists the Quest's criteria with their ids and states, and `read_tasks` of any Task under the Quest shows them, since a session never sees what `start_quest` returned in an earlier one. Every id a Task tool takes has such a place, which `packages/domain/test/task-tools.test.ts` checks.
- **The gate reads them.** A Quest's Task completes only once each required criterion is accepted or waived (`criteria-unmet`), whatever its lead says. The gate reads them after the completion's own artifacts are registered, in its transaction, so a version that completion makes voids the evidence it replaces and the completion is refused, with nothing written.
- **Only you waive a required one.** A lead's waiver of a required criterion does not waive it: the hub asks you, in a question to you about the Quest with the choices Waive it and Keep it, and keeps that question on the criterion. Your Waive it waives it, in the transaction that records your answer, and the waiver names you, from your session (STD-SEC-006); Keep it, or an answer in words, leaves it as it was. Nothing in the lead's turn stands for your answer, not even your message asking to skip it. A lead waives an optional criterion itself.
- **What you see.** The quest's sheet lists the criteria under Done when, each with its state, the versions it was accepted on, who decided last, and whether a waiver waits on your answer. You answer that on the question's card; a control to waive one from the sheet itself waits for the quest's reply thread ([ADR 039](039-shared-camps.md)).

## Amendment: pause, a lead's retry and reassign, and your note to a member ([#1446](https://github.com/otaviobarros/hobbots/issues/1446))

You could cancel a Quest but not hold it, a lead could not retry or reassign the work it leads, and anything you said in a Quest reached only its lead.

- **Pause, Pause now and Resume.** Pausing a Quest or a Task holds it and everything under it still under way. The Task machine gains `pausing`, while a turn that ran as you paused ends, and `paused`; the Quest machine gains `paused`, kept in step with its Task. Pause lets a running turn end; Pause now stops it. A Task's pause records where it stood, who paused it, when, and whether it was Pause now, so Resume puts it back there and a restart loses nothing. Resume tells each hob that goes back to work what changed while it was paused, from the records.
- **A lead retries and reassigns.** `retry_task` and `reassign_task` reach a member's Task directly under the lead's own, as `message_task` does. Each takes a reason, the Task's revision as the lead read it and an idempotency key, and is refused when the Task changed since, while its last Attempt may still run, or by the rules your own Retry and Reassign follow. A reassign works the new hob's authority out again rather than keeping the old member's. The journal names the lead and its reason on the change.
- **Your note to a member.** An @mention of a member in a Quest's chat reaches that member's Task as your note, and does not wake the lead, which reads it on its next turn. Its receipt shows only what the hub recorded.

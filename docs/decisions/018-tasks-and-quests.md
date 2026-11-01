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

Example: you ask Aldric, the chief of marketing, for a Black Friday campaign. Aldric writes the Quest's goal and splits it into Tasks: Quill drafts the copy, and Ada builds the campaign once the copy exists. Both start at once. Ada does keyword research while she waits, and her Task shows "waiting on Quill". When Quill finishes, Aldric checks the copy and hands it to Ada. Aldric reviews both results and posts one message in your chat with what was made and where it is.

### Rules

- **You talk only to the lead.** Everything you say about a Quest goes to the lead, who passes it on with its own context. A note you leave on a member's Task reaches the lead as a message about that Task. The drawer and the Quest tab still show everything a member does. Talking to a member directly is out of scope.
- **Controls act directly.** Cancel, Retry and Reassign act on a Task without going through the lead, under the orchestration contract's cancellation rules.
- **A member's approvals come straight to you.** When a member's tool call needs approval, it reaches you as on any other turn. A lead never approves on your behalf (PE-006).
- **Questions go up.** A member's question goes to its nearest lead, who answers it or escalates it. It reaches you only when no lead can answer, on the card and in the Inbox. Your answer goes back down the same chain to the hob that asked.
- **Members never talk to each other.** A result moves from one member to another only as a hand-off through the lead.
- **Nested Quests.** A member can bring in a hob of its own and lead that subtree under the same rules. The lead of a subtree is the nearest lead for its own members.
- **Depth counts Quests, not steps.** A Quest is depth 1, and a member's own Quest inside it is depth 2. Steps never add depth. The limit is 2 by default and configurable, so Aldric → Rook → Pip fits and Pip cannot bring in another hob.

### Approvals for this Task or Quest

ADR 015's middle lifetime is bound to the work, not to the word. A grant saved with it is bound to the **top Task** of the request's tree: the Task you asked for, whether or not it has become a Quest.

- The card says **This Task** for a Task without a party and **This Quest** once a party joins. Both are the same lifetime.
- A Task that grows into a Quest keeps its id, so a grant given before the party joined still applies after.
- Steps are in the same tree, so one grant covers every step of the Task, even though each runs in a fresh session.
- A grant still belongs to one hob, and delegation never passes it on (PE-004). A party member asks for its own grant, bound to the same top Task, so it ends with the Quest.
- The grant ends when the top Task ends, or when it is revoked.
- The Inbox groups requests by their top Task, named as a Task or a Quest. Requests outside any Task stay grouped by hob and thread.

### Checkpoints

A checkpoint is a short record of where a Task stands. It comes from one of three sources:

| Source | Kinds | Who records it |
|---|---|---|
| Planned | Milestones the lead sets in a brief, reported when reached | The Task's owner |
| Unplanned | Findings that may change the plan, blockers and questions, reported when the owner decides they matter | The Task's owner |
| Automatic | Started, waiting, done, failed and cancelled | The hub |

Milestones, findings, blockers, questions, done and failed reach the lead's context and can wake it. Routine progress only updates the screens and never wakes the lead (IN-005), and it may be coalesced before it is journaled ([ADR 013](013-event-journal.md)).

### Records

Each record has a stable id and explicit lineage, and every change is written with its journal event in one transaction ([ADR 013](013-event-journal.md)).

| Record | Holds | Lineage |
|---|---|---|
| Task | Owner, parent, root, brief, state, dependencies, result, version | Parent Task and root Task; a step has its parent's owner |
| Quest | Goal, acceptance, limits, lead, party, state | The Task it was added to; the thread that started it, or for a nested Quest the Quest it sits in |
| Delegation | The brief from lead to member, narrowed authority, timeout | Lead, member, parent Task and child Task |
| Attempt | Runtime, session, configuration and policy versions, outcome | Task; a retry is a new Attempt, never a new Task |
| Milestone | Title, order, when it was reached | Task whose brief or Quest planned it |
| Checkpoint | Source, kind (milestone, finding, blocker, question, progress or an automatic state), summary | Task and Attempt |
| Question | Asker, current recipient, the escalation chain, answer | Task that asked it |
| Artifact reference | A file, link or text a Task made | Task and Attempt that produced it; a hand-off adds it to the receiving brief |

Attempt is the record the agent model also calls Execution. Approvals stay the records from [ADR 015](015-approval-lifetimes-and-grants.md).

| Event | Journaled when |
|---|---|
| `TaskCreated` | A Task, a step or a delegated Task is created, with its Delegation and Milestones |
| `TaskStateChanged` | A Task's state, owner or current Attempt changes, including cancel, retry and reassign |
| `QuestStarted` | A Task gains its Quest record |
| `CheckpointRecorded` | A Checkpoint is recorded, including a reached Milestone |
| `QuestionAsked`, `QuestionAnswered`, `QuestionEscalated` | A Question is asked, answered or passed up |
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
| `wait_for` | A Task's owner | Waits for any or all of its child Tasks, steps or members' Tasks, without blocking its chat | Wait record |
| `complete_task` | A Task's owner | Returns the result; the server checks the completion gate | Result, Task state |
| `cancel_task` | A Task's owner | Cancels one of its child Tasks and that Task's subtree | Cancel request, then confirmed outcomes |

On every call the server checks:

- **Who may call it:** the Task's owner, or a lead above it in the tree. A hob can never act on a Task outside its own subtree.
- **Depth:** a delegation past the depth limit is refused.
- **Concurrency and time limits:** per hob, per Quest and per runtime session, with Task deadlines, as the orchestration contract sets them.
- **No cycles:** a hob cannot be given a Task whose lineage it already leads.
- **Authority only narrows:** a child's permissions and limits are the intersection of its own and its parent's. A brief cannot widen them.
- **Idempotency:** each call carries a key, so a retried call returns the first result and never creates a second Task, Question or hand-off.

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
- Continuation after a turn ends (Slice 10) and different runtimes in one Quest (Slice 11) are out of scope.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- Records keep lineage and their invariants, and each change is journaled with its event: `[TC-OR-001]`, `[TC-OR-002]`, `[TC-OR-003]`, `[TC-OR-004]`, `[TC-OR-005]`, `[TC-OR-008]`, `[TC-OR-009]`, `[TC-EX-016]`, on SQLite and PostgreSQL. A Task tree and a Quest read with a cursor the event stream resumes from: `[TC-OR-006]`.
- Each hob tool is refused for a caller outside its subtree, past the depth limit, in a cycle or with wider authority, and a retried call is idempotent: `[TC-OR-010]` to `[TC-OR-020]` and `[TC-OR-024]`, at hub level with the fake runtime on SQLite and PostgreSQL ([#271](https://github.com/otaviobarros/hobbots/issues/271)). Serving the tools to a real Claude Code is not verified yet.
- Aldric splits a long Task into steps; the card shows "step 2 of 4" and he keeps only checkpoints, not each step's session: not proven yet, [#272](https://github.com/otaviobarros/hobbots/issues/272).
- Aldric leads a Quest with Quill and Ada in parallel; Ada waits on Quill's copy, which reaches her through Aldric: not proven yet, [#273](https://github.com/otaviobarros/hobbots/issues/273).
- Quill's question is answered by Aldric without reaching you; Ada's escalated question reaches you and your answer gets back to her; routine progress never wakes Aldric: not proven yet, [#274](https://github.com/otaviobarros/hobbots/issues/274).
- A party member that brings in another hob shows nested in the tree, and a recursive delegation loop is stopped by the limits: not proven yet, [#275](https://github.com/otaviobarros/hobbots/issues/275).
- A This Task grant covers every step of the Task, still applies after the Task becomes a Quest, is never used by another hob, and ends with the top Task: not proven yet, [#273](https://github.com/otaviobarros/hobbots/issues/273).
- Cancelling the Quest ends with every Task confirmed or explicitly unresolved; Retry adds an Attempt and Reassign keeps history: not proven yet, [#276](https://github.com/otaviobarros/hobbots/issues/276).
- The card, strip, drawer and Quest tab show the work as decided: not proven yet, [#277](https://github.com/otaviobarros/hobbots/issues/277), [#278](https://github.com/otaviobarros/hobbots/issues/278).
- A party member's work shows "On Aldric's quest" with its Task's state on Home and in its panel, opens the Quest, and is never one of its threads: `[TC-UX-020]`. A hob's work on other hobs' Quests reads with a cursor and stays listed until its Quest ends, with the hob whose thread follows a nested Quest: `[TC-OR-021]`, `[TC-OR-022]`, `[TC-OR-023]`.
- The whole slice runs end to end with an evidence record: not proven yet, [#280](https://github.com/otaviobarros/hobbots/issues/280).

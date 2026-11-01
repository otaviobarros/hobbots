# Orchestration and responsibility

**Decided.** Every agent is a proactive worker. An orchestrator is an ordinary agent used for coordination, with no special runtime type. It can do its own work and delegate concurrently; any delegated agent can do the same within policy.

## Tasks, steps and Quests

**Decided** ([ADR 018](../decisions/018-tasks-and-quests.md)). Work is named by who does it. A **Task** is one hob's piece of work, end to end. A **step** is a part of a Task that its own hob runs in a fresh session from a short brief. A **Quest** is a Task that brings in other hobs: the hob you asked is its **lead**, and the hobs helping are its **party**.

- Steps, members' work and nested Quests are all Tasks in one tree. A Task whose children all have its owner is a Task with steps; splitting work into steps never makes a Task a Quest.
- A Task becomes a Quest when its owner first delegates to another hob or starts a Quest explicitly. The Quest record is added to the same Task, which keeps its id, card and history.
- You talk only to the lead. Cancel, Retry and Reassign act on a Task directly. A member's approvals come straight to you; a lead never approves for you (PE-006).
- A member's question goes to its nearest lead, who answers or escalates it. Only a question no lead can answer reaches you, and your answer goes back down the same chain.
- Members never talk to each other. Results move between them only as hand-offs through the lead.
- A member can lead its own subtree under the same rules. Depth counts Quests, not steps, and is 2 by default.

### Checkpoints

Checkpoints come from three sources: milestones the lead plans in a brief; findings, blockers and questions the owner reports when they matter; and the automatic states started, waiting, done, failed and cancelled, which the hub records. Milestones, findings, blockers, questions, done and failed reach the lead's context and can wake it. Routine progress only updates the screens (IN-005).

## Delegation contract

A request records delegation ID, Quest ID (once the Task is a Quest), parent task, lead, member, objective/instructions, expected output, priority, context artifact references, permitted scope and timeout/budget policy. The server validates identity, authorization, capacity, depth/cycles and input schemas before dispatch. A child cannot gain authority by receiving more ambitious prose.

Expose controlled Hobbots tools through MCP or a supported equivalent adapter integration. These are Hobbots-level operations, not vendor method names. MCP is a transport/control boundary; it does not replace inbox durability or the scheduler.

| Tool | Who may call it | What it does |
|---|---|---|
| `plan_steps` | A Task's owner | Splits its own Task into steps, each with a brief |
| `start_quest` | A Task's owner | Turns its Task into a Quest with a goal, milestones and limits |
| `delegate_task` | A Task's owner, which becomes or already is its lead | Gives another hob a Task with a brief, milestones and dependencies; the first call makes the Task a Quest |
| `report_checkpoint` | A Task's owner | Reports a milestone, finding, blocker or progress |
| `ask` | A Task's owner | Asks a question, routed to the nearest lead |
| `answer` | A lead | Answers a question from its subtree |
| `escalate` | A lead | Passes a question to the next lead, and from the top lead to you |
| `hand_off` | A lead | Gives one Task's result to another Task as an artifact reference |
| `wait_for` | A Task's owner | Waits for any or all of its child Tasks without blocking its chat |
| `complete_task` | A Task's owner | Returns the result, subject to the completion gate |
| `cancel_task` | A Task's owner | Cancels one of its child Tasks and that Task's subtree |

`list_tasks`, `get_task` and `get_quest_status` stay as read tools, scoped to the caller's subtree. `send_agent_message` reaches only between a lead and its own members; members never message each other. Tool names can change during implementation; what each one does is decided in [ADR 018](../decisions/018-tasks-and-quests.md).

On every call the server checks who may call it (the Task's owner or a lead above it in the tree), depth, concurrency and time limits, that the delegation makes no cycle, that the child's authority only narrows, and the call's idempotency key, so a retried call never creates a second Task, Question or hand-off.

How the hub holds these today ([#271](https://github.com/otaviobarros/hobbots/issues/271)):

- The caller is the hob whose turn it is and the Task that turn works on, never anything in the input. A call reaches only that Task and the Tasks under it, so a step's session never reaches its sibling.
- Every input carries a `key`. The hub keeps each call's result per hob and key, with the input and the Task the turn works on, written in the same transaction as the call's records, so a retry returns the first result and writes nothing. A key sent again with a different call is refused. A refused call stores nothing, so its key stays free.
- A refused call writes nothing and returns a reason the hob can act on, such as `not-owner`, `not-lead`, `outside-subtree`, `cycle`, `depth-limit`, `concurrency-limit`, `authority-wider`, `deadline-passed` or `key-reused`, or the records' own reason.
- A member's Delegation stores the lead's authority on its Task, narrowed by every Delegation above it, by what the brief asks for and by the member's own policy. A brief that asks for more than the lead has is refused, not trimmed. Applying it to the member's turns comes with running delegated work ([#273](https://github.com/otaviobarros/hobbots/issues/273)).
- Open-Task limits count Tasks that have not ended: per hob (16 by default) and per request's tree (32 by default), with depth 2 by default. `HOBBOTS_QUEST_MAX_DEPTH`, `HOBBOTS_MAX_OPEN_TASKS_PER_HOB` and `HOBBOTS_MAX_OPEN_TASKS_PER_TREE` change them. Running concurrency per runtime session and Task deadlines while work runs belong to the scheduler.
- `wait_for` records a wait and shows the Task as waiting. Waking the owner when the wait is met belongs to the inbox.

Structured tasks/results coexist with conversational exchanges. Questions preserve sender, recipient and relevant task/delegation ID, and the chain of leads they passed through. A request to clarify a date range does not need a new Quest. Natural-language messages cannot bypass structural lifecycle and policy validation.

## Coordination loop

Receive objective/event → execute and delegate → track promises/dependencies → receive durable outcomes → reconcile remaining work → continue authorized work or expose a blocker → verify and report completion.

The parent may continue while children execute and may await any/all/a selected set of outcomes. Persist explicit waiting relationships, not heuristics based on silence. Show owner, expected return, elapsed time, acknowledgement, timeout and possible intervention. Active work and outstanding communication can coexist, so one flattened status is insufficient.

## Scheduling and limits

Bound active executions per executor, agent and Quest and enforce supported runtime session concurrency. Prevent delegation cycles and unlimited depth. Apply bounded retries, task deadlines and cost/usage limits where the runtime provides reliable usage data. Missing cost telemetry must be visible rather than presented as a precise budget guarantee.

The depth limit is 2 by default ([ADR 018](../decisions/018-tasks-and-quests.md)). Concurrency, per-agent active tasks and task timeout defaults are open (for example three parallel tasks, two active tasks per agent, a fifteen-minute timeout). Exact fairness, batching and timeout policies require resolution; make them configurable rather than hard-coded.

Cancellation/reassignment propagates as explicit commands and retains history. Late child results are reconciled against current ownership and task version. A canceled parent does not permit a delayed child event to restart unauthorized work. Partial useful results may be retained without misrepresenting success.

## Completion gate

Before successful closure, reconcile required child outcomes, unresolved questions, promised artifacts, blocking approvals and final result. A model saying “done” does not override the gate. If the objective cannot be met within authority, capability or limits, persist a blocked/failed outcome with evidence and an actionable explanation.

The core acceptance loop is Aldric → Rook → Sage/Pip, with independent work in flight, results arriving after a turn ends, automatic continuations, verification and final reporting. Run it across runtime boundaries and through injected restart/disconnection failures.


## Responsiveness and duration

The coordinating agent can respond to other user messages while delegated tasks continue. Serialize prompts only within a runtime session that requires it; do not block the entire agent or the whole workspace on a synchronous child call. Prefer live progress/events plus durable final results over unsolicited frequent chat turns. The exact progress batching cadence remains open; a final-result-only implementation would lose the locked visibility behavior.

Quest duration should be configurable with no universal hard cutoff, rather than a fixed maximum lifetime. Outstanding work still needs deadlines, budgets, stalled-state visibility and bounded retry behavior.

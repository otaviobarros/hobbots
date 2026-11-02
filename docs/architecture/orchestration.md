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
- A member's Delegation stores the lead's authority on its Task, narrowed by every Delegation above it, by what the brief asks for and by the member's own policy. A brief that asks for more than the lead has is refused, not trimmed. Folders are compared at the hub's own path separator only, so on macOS and Linux a name with a backslash is never inside another folder. Every turn of the member works under it ([#273](https://github.com/otaviobarros/hobbots/issues/273)).
- Open-Task limits count Tasks that have not ended: per hob (16 by default) and per request's tree (32 by default), with depth 2 by default. Depth and deadlines come from every Quest on the Tasks above, whichever started first, so a Quest started later on a Task above still limits the work under it. `HOBBOTS_QUEST_MAX_DEPTH`, `HOBBOTS_MAX_OPEN_TASKS_PER_HOB` and `HOBBOTS_MAX_OPEN_TASKS_PER_TREE` change them. Running concurrency per runtime session and Task deadlines while work runs belong to the scheduler.
- `wait_for` records a wait and shows the Task as waiting. Waking the owner when the wait is met belongs to the inbox.

How a Task's steps run today ([#272](https://github.com/otaviobarros/hobbots/issues/272)):

- Every chat turn offers the Task tools. A turn works on the latest Task asked of its hob in the thread that has not ended. When there is none, `plan_steps`, `start_quest` or `delegate_task` starts one from the turn's prompt, in the same transaction as the call, so a refused call leaves no Task behind. That Task counts against the hob's open-Task limit like any other, so a hob at its limit is refused with `concurrency-limit`; any other call is refused with `no-task`. The turn that starts the Task, and the turn that returns its result, each run as an Attempt of the Task that ends with the turn.
- The hub starts a step once every step it comes after has completed, oldest first, in a fresh runtime session. The session gets the hob's identity and instructions, the step's brief, the results and artifacts of the steps it comes after, anything handed to it, and its open milestones. Each result and artifact reaches it cut to 4,000 characters, and all of them together to 16,000. Nothing of the hob's chat or of other steps reaches it.
- A step's session offers only `report_checkpoint` and `complete_task`. When it ends without returning a result, its final reply, redacted and cut to 4,000 characters, becomes the step's result. A session that fails fails the step, with the reason on its Attempt; the steps after it stay queued. Each tool call a step makes is recorded as a progress checkpoint before it runs (EX-004). A call the policy answers Ask for is refused, since a step has no conversation to ask in.
- At most 2 steps run at once per hob and 3 per request's tree by default; the others wait their turn. `HOBBOTS_MAX_RUNNING_STEPS_PER_HOB` and `HOBBOTS_MAX_RUNNING_STEPS_PER_TREE` change them. A paused hob's steps wait until it wakes; a retired hob's never start.
- The owner's chat turn is told, for the Task it works on, each step's state and its result or latest reported checkpoint, each cut to 600 characters, never its session. When a step's result or failure arrives after the owner's turn has ended, it starts a continuation in the thread without you prompting ([#292](https://github.com/otaviobarros/hobbots/issues/292), [backpack contract](inbox.md#the-dispatcher)).
- Cancelling a step stops its session and confirms the cancel, and a Task above it whose cancel was asked for is confirmed once nothing under it runs. Stopping its hob, or narrowing its hob's permissions (PE-008), stops it too and fails it, with why on its Attempt; a step that is starting is registered with its session under the same lock the review takes, so a narrowing never misses it. A step that returns its result keeps its session until the session ends. A step that replies completes before its Attempt ends, so a restart in between keeps its result. After a restart, every Attempt left live ends as interrupted, and then every step that started and has not ended, with no live Attempt, ends, the steps under it first: it fails, since what it did is not known, or is cancelled when its cancel was asked for, and a Task above it whose cancel was asked for is confirmed. Its result or failure then reaches its hob through the backpack like any other ([#295](https://github.com/otaviobarros/hobbots/issues/295)).
- A step that comes after one that failed or was cancelled stays queued, and the owner is told it cannot start; cancelling it, or retrying the failed one ([#276](https://github.com/otaviobarros/hobbots/issues/276)), lets the Task finish.
- A key is unique among a hob's calls, so a key from an earlier request is refused, never replayed; a retry within the same reply, Continue included, returns the first result.

How a party member's Task runs today ([#273](https://github.com/otaviobarros/hobbots/issues/273)):

- A Task delegated to another hob runs in that member's own runtime session, never in a chat thread. The member starts as soon as its Task item reaches its backpack, so members of one Quest work in parallel, at most 2 at once per hob with the step limit. A paused hob's Tasks wait until it wakes. A retired hob's Task fails with a blocker that says why, whether its turn was running or not yet started, so its lead hears of it.
- Each turn of the session is an Attempt of the Task, started by the dispatcher with the items the member holds under the Task: first the Task itself, later a hand-off, an answer or the result of one of its own steps. The first turn starts a fresh session from the lead's brief, what the lead expects back, the Tasks it comes after and anything already handed to it, and its open milestones. Each later turn resumes the same session, with Hobbots' own prompt listing what arrived.
- The member works under its own policy, narrowed by every Delegation on the way down to its Task: each Delegation's decisions apply as a restriction, and it keeps only the folders each one allows, which become the only folders the policy engine lets it reach. A narrower policy saved while a turn runs stops that turn, as for steps (PE-008); its Task waits and goes on in the same session once work arrives again.
- A member's tool call that its policy answers Ask for asks you directly in the Inbox, under the member's name and its lead's thread, which Open chat opens; the lead never decides it (PE-006). The request names the member's Task, which its ledger lists while it waits.
- The member offers every Task tool on its Task: it reports, asks its lead, plans its own steps, brings in a hob of its own within the depth limit, and returns its result with `complete_task`. Members never reach each other: a result moves between them only as the lead's `hand_off`.
- A turn that ends without the result completes the Task with its final reply once nothing keeps it open. The first turn of a Task that comes after others does not while one of them is not done or nothing has been handed to it yet, since what it needs comes later, through its lead: the Task waits. A Task with only its own milestones unreported is blocked, with a blocker that says so, and its lead hears of it. Anything else still open leaves the Task waiting for the work that settles it.
- The lead waits for any or all of its members with `wait_for` and keeps answering you meanwhile. Each member's result, failure, blocker or question starts the lead's next turn in your chat ([#292](https://github.com/otaviobarros/hobbots/issues/292)), where it hands results on, answers and finally completes the Quest; that last reply is the wrap-up in your chat.
- Not yet: a member's Task that waits with no turn running is confirmed cancelled only with [#276](https://github.com/otaviobarros/hobbots/issues/276); a restart ends only steps, so a member's Task whose turn it cut off stays open and goes on in the same session once its work is delivered again; a retired member's Task with no work waiting stays as it is until work arrives for it; a turn that fails is retried by the dispatcher and, once its deliveries run out, left for [#296](https://github.com/otaviobarros/hobbots/issues/296) to block with a next action.

Structured tasks/results coexist with conversational exchanges. Questions preserve sender, recipient and relevant task/delegation ID, and the chain of leads they passed through. A request to clarify a date range does not need a new Quest. Natural-language messages cannot bypass structural lifecycle and policy validation.

## Coordination loop

Receive objective/event → execute and delegate → track promises/dependencies → receive durable outcomes → reconcile remaining work → continue authorized work or expose a blocker → verify and report completion.

The parent may continue while children execute and may await any/all/a selected set of outcomes. Persist explicit waiting relationships, not heuristics based on silence. Show owner, expected return, elapsed time, acknowledgement, timeout and possible intervention. Active work and outstanding communication can coexist, so one flattened status is insufficient.

## Scheduling and limits

Bound active executions per executor, agent and Quest and enforce supported runtime session concurrency. Prevent delegation cycles and unlimited depth. Apply bounded retries, task deadlines and cost/usage limits where the runtime provides reliable usage data. Missing cost telemetry must be visible rather than presented as a precise budget guarantee.

The depth limit is 2 by default ([ADR 018](../decisions/018-tasks-and-quests.md)). Concurrency, per-agent active tasks and task timeout defaults are open (for example three parallel tasks, two active tasks per agent, a fifteen-minute timeout). Exact fairness, batching and timeout policies require resolution; make them configurable rather than hard-coded.

Cancellation/reassignment propagates as explicit commands and retains history. Late child results are reconciled against current ownership and task version. A canceled parent does not permit a delayed child event to restart unauthorized work. Partial useful results may be retained without misrepresenting success.

## Completion gate

Before successful closure, reconcile required child outcomes, unresolved questions, promised artifacts, blocking approvals and final result. A model saying “done” does not override the gate. The gate reads the [responsibility ledger](inbox.md#responsibility-ledger), and a Quest closes only when the Task it sits on passes it. If the objective cannot be met within authority, capability or limits, persist a blocked/failed outcome with evidence and an actionable explanation.

The core acceptance loop is Aldric → Rook → Sage/Pip, with independent work in flight, results arriving after a turn ends, automatic continuations, verification and final reporting. Run it across runtime boundaries and through injected restart/disconnection failures.


## Responsiveness and duration

The coordinating agent can respond to other user messages while delegated tasks continue. Serialize prompts only within a runtime session that requires it; do not block the entire agent or the whole workspace on a synchronous child call. Prefer live progress/events plus durable final results over unsolicited frequent chat turns. The exact progress batching cadence remains open; a final-result-only implementation would lose the locked visibility behavior.

Quest duration should be configurable with no universal hard cutoff, rather than a fixed maximum lifetime. Outstanding work still needs deadlines, budgets, stalled-state visibility and bounded retry behavior.

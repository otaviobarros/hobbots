# ADR 019 — A hob's backpack and continuations

Status: **Accepted.** Refines [ADR 004](004-durable-inbox.md), the [inbox contract](../architecture/inbox.md), the [execution lifecycle](../architecture/execution-lifecycle.md) and [ADR 018](018-tasks-and-quests.md) for Slice 10 ([#11](https://github.com/otaviobarros/hobbots/issues/11)).

## Context

ADR 004 decided that results, questions and promises are durable and that a hob continues when they arrive. The draft inbox contract set out the states and the delivery steps but left the transaction, the keys and the wake open.

Three pieces on `main` already do part of the job, each in its own way:

- **The chat queue.** Queued messages start when a thread's turn ends, after a restart and when a paused hob wakes (CH-008). The trigger lives in the chat service.
- **The approval wake.** A decision on a tool call resumes the turn that waits for it, through an in-memory waiter. A request whose turn died with the process expires at boot ([ADR 015](015-approval-lifetimes-and-grants.md)).
- **The event journal.** It records every change in the same transaction ([ADR 013](013-event-journal.md)), but nothing tracks that a hob still has to act on one.

Slice 9 adds hob tools ([#271](https://github.com/otaviobarros/hobbots/issues/271)) whose results, questions and hand-offs must reach a lead whose turn has often ended. Adding a third trigger for them would leave three wake paths with three sets of recovery rules.

"Inbox" is also already your page: approvals and questions that need you (screen 8). A hob's queue needs its own word, or the two get confused.

## Decision

### The name

A hob's durable queue is its **backpack**, and an entry in it is a **backpack item**. It holds what a hob still has to deal with: results to read, questions to answer, answers to its own questions, hand-offs and deadlines.

- **Your Inbox** is what needs *you*: approval requests and questions no lead could answer. It is unchanged.
- **A hob's backpack** is what needs *that hob*. You can look into it, but you never work it.
- An escalated question is a Question record that shows in your Inbox. Your answer becomes a backpack item for the hob that asked.

Code, docs and UI use the same words for the records and types (`BackpackItem`). The package keeps its module name, `@hobbots/inbox`, and the contract keeps its file, `inbox.md`.

### Item kinds

| Kind | Made when | Goes to | Actionable |
|---|---|---|---|
| Task | A lead delegates a Task to a member, or a step is planned | The new Task's owner | Yes: it starts the work |
| Result | A child Task or step passes the completion gate | The parent Task's owner | Yes |
| Failure | A child Task fails, is blocked, or its cancellation is confirmed or left unresolved | The parent Task's owner | Yes |
| Checkpoint | A member reports a milestone, finding or blocker | Its nearest lead | Yes |
| Question | A member asks, or a lead escalates | The nearest lead that has not seen it | Yes |
| Answer | A lead or you answer a question | The hob that asked | Yes |
| Hand-off | A lead gives one Task's result to another Task | The receiving Task's owner | Yes |
| Message | Your note on a Task, or `send_agent_message` between a lead and its member | The lead, or the member | Yes |
| Approval outcome | A tool call's request is decided or expires and no live turn waits for it | The hob that asked | Yes |
| Deadline | A `wait_for` deadline or a Task deadline passes | The waiting Task's owner | Yes |
| Progress | A member reports routine progress, or the hub records started or waiting | The nearest lead | No: routine |

Actionable items can wake a hob. Routine items never wake a hob on their own (IN-005). They update the screens at once and reach the hob as a digest in its next turn.

### States and their evidence

| State | Means | Records |
|---|---|---|
| Pending | Committed with the change that caused it, waiting for a turn | Item id, recipient hob, kind, actionable or routine, Task and Quest ids, correlation, dedupe key, payload, created at, not before (deadlines only) |
| Delivered | Put into a turn: the prompt of a continuation, or a live turn's waiting tool call | A delivery attempt: number, target, the turn's message or Attempt id, runtime session, time |
| Acknowledged | The runtime accepted the turn that carries it | The adapter's start evidence for that turn: the runtime session id and the time it reported it |
| Processing | That turn is running and holds the item's claim | Claim owner, fencing token, lease expiry |
| Resolved | Handled | A disposition: `consumed` with the turn that ended or the `complete_task` call that settled it, `answered` with the tool call, `late` with the Task version it was checked against, or `dismissed` with who dismissed it |
| Failed | Delivery or processing exhausted its retries, or the recipient can no longer take it | The error, every attempt, and the blocker with its next action (IN-007) |

Inactivity is never acknowledgement. Only the adapter's own evidence moves an item to Acknowledged. An item whose turn ends early, by interruption, a crash or a runtime failure, goes back to Pending with a new attempt. It never counts as resolved.

### Idempotency keys

Every item has a dedupe key. The backpack stores at most one item per recipient and key, and a second insert with the same pair changes nothing.

- **From a hob tool call.** The key is the tool call's own idempotency key from #271, plus the item's role in that call. The hob tools store each call under the calling hob and its key (`task_tool_calls`), and refuse the same key with another tool, input or Task. So `complete_task` by Quill makes `tool:<quill>:<key>:result`. A retried call returns the first result and writes nothing, so it makes no second item either.
- **From a hub change.** The key is the source record's id and the version that caused it: `task:<id>:v<version>`, `approval:<id>:decided`, `deadline:<wait id>`.
- **From your command.** Answers and notes reuse the command's idempotency key from the client.

The processing side deduplicates by item id. Any effect an item causes, such as a Task change, carries the item id, so applying it twice finds the first result.

**Retention.** An item and its key stay while the top Task is open and for 30 days after it ends. Items outside any Task stay for 30 days after they resolve. Both windows are configurable. A duplicate that arrives after its item was removed is checked against the source record, which has ended by then, and is recorded as late, not applied.

### Claims, leases and fencing tokens

A worker claims an item before it delivers it, and holds the claim until the item resolves or goes back to Pending.

- A claim records its owner (the hub process and the turn), a **lease** with an expiry, and a **fencing token**. The token is an integer that grows by one on every claim of that item, and again whenever a claim ends without its owner.
- The worker renews the lease while the turn runs, on the turn's text checkpoint cadence ([ADR 013](013-event-journal.md)). The default lease is 60 seconds and is configurable. A renewal is guarded the same way as an outcome, so an expired claim cannot be renewed.
- Every write that applies an item's outcome checks three things in one conditional update, in the same transaction as the change: the token still matches, the claim's owner is still this worker, and the lease has not expired by the database's clock. If any check fails, the write changes nothing, and the worker discards the outcome and logs it.
- **Expiring a claim is a write of its own.** When the dispatcher finds a lease past its expiry, it clears the owner and raises the token in one update, and the item goes back to Pending. A worker whose lease expired is therefore refused at once, even before any other worker claims the item.
- At boot every claim held by an earlier process is expired the same way, because its turns are gone.

The same rule works on SQLite and PostgreSQL, because it needs only a conditional update.

### One wake path: the dispatcher

Every turn that you did not start with Send is started by one **dispatcher**. It replaces the chat queue's own trigger and the approval wake. It is not a third path.

- **Targets.** An item goes to the session that owns its Task: the top Task's thread for that Task's owner, or the current Attempt's session for a member's Task or a step. An item outside any Task goes to its thread.
- **Live turn first.** When a running turn waits for the item, as a tool call waits for its approval, the dispatcher delivers it into that turn. No new turn starts. Today's approval waiter becomes this branch.
- **Otherwise a continuation.** When the target is idle, the dispatcher starts one turn that carries every pending actionable item for that target, with the routine digest. Thirty items make one turn.
- **Your words come first.** Queued chat messages stay messages (CH-008) and are not copied into the backpack. When a thread has a queued message, it starts first, and the pending items ride along in the same turn as context.
- **Busy target.** Items wait. When the running turn ends, it asks the dispatcher for the next turn instead of draining its own queue.
- **Gates.** The dispatcher starts a turn only when the hob is active, within its concurrency limits and budget, and still owns or leads the Task. A paused hob keeps its items until it wakes. A retired hob's items fail, and its lead gets a Failure item with a next action.
- **Triggers.** The dispatcher runs after a commit that adds an item, when a turn ends, when a hob wakes, when a not-before time passes, and at boot. The publish after commit only wakes it. The stored items decide what runs, as the journal does for the event stream.

A continuation's prompt is written by Hobbots and says so. It lists each item with who sent it and why, and it is never shown as a message from you.

### Late results

An item for a Task that was cancelled or reassigned is still recorded. When it is processed, the dispatcher checks it against the Task's current owner and version. If the recipient no longer owns or leads the Task, or the Task has ended, the item resolves as `late` and starts nothing. A late result stays on the Task as a late Attempt outcome, so it can still be inspected ([#276](https://github.com/otaviobarros/hobbots/issues/276), handled in [#291](https://github.com/otaviobarros/hobbots/issues/291)).

### The responsibility ledger is a read

The responsibility ledger is a query, not a table. It reads the Task tree and the backpack together: open child Tasks, wait records, unanswered Questions, milestones not reached, promised artifacts, pending approvals, and backpack items not yet resolved. `complete_task`'s completion gate from #271 and a Quest's closure call the same query.

**A turn can pass its own gate.** The items a turn carries are still Processing while it runs, including the Task item that started the work. The gate leaves out the items that the calling turn holds a valid claim on, under the same three checks as any outcome. When `complete_task` succeeds, it resolves those items as `consumed` in the same transaction as the Task's completion. An item that arrived during the turn and was not delivered to it still blocks the gate, so the hob sees it before it finishes. A refused gate returns which items and children are open, so the hob can act on them in the same turn.

Until the dispatcher exists, no turn holds a claim, so a turn also carries an item it was briefed with before any worker claimed it: the gate leaves it out only while it is still pending, unclaimed and at the fencing token the turn saw, and the completion resolves it under that same check ([#294](https://github.com/otaviobarros/hobbots/issues/294)). The [backpack contract](../architecture/inbox.md#responsibility-ledger) lists what each turn carries.

### Where items come from

The hob tools from #271 deliver nothing and wake no one. `wait_for` only records the wait in `task_waits`. Every tool call already journals its change with its events, such as `TaskCreated`, `CheckpointRecorded`, `QuestionAsked`, `HandedOff` and `TaskCompleted` ([ADR 018](018-tasks-and-quests.md#records)), in the same transaction as the call's stored result.

The backpack hooks in there, so the tools need no change. [#290](https://github.com/otaviobarros/hobbots/issues/290) adds one pure function: given the journal events a change produces, it returns the backpack items to record. The repository writes those items in the same transaction as the change and its events, exactly as it writes journal events. Approval decisions, deadlines and your answers and notes go through the same function.

### Events

Two journaled events let the screens follow the backpack: `BackpackItemRecorded` when an item is committed, and `BackpackItemChanged` when its state changes. Routine items may be coalesced before they are journaled ([ADR 013](013-event-journal.md)).

### Retries

Delivery retries with bounded backoff. The default is three attempts per item and is configurable. When the attempts run out, the item fails with a blocker and a next action ([#296](https://github.com/otaviobarros/hobbots/issues/296)).

## Rationale

A word of its own keeps "your Inbox" meaning one thing: what needs you. A backpack is what a hob carries between turns, which is exactly the obligation that must survive a turn ending. It is an everyday word and the inventory of every adventure game, so it fits the guild theme without needing explaining.

One dispatcher means one place that decides when a hob runs, with one set of gates and one recovery at boot. The chat queue and the approval wake already solve small cases of the same problem. Folding them in removes two ad hoc triggers instead of adding a third.

Reusing #271's idempotency keys puts the dedupe at the source. A retried tool call and a redelivered item both land on the same row, so neither can make a second Task or effect. Fencing tokens are the standard guard against a paused or partitioned worker that wakes up after its lease ran out, and a conditional update is enough on both databases.

Reading the ledger from the Task tree avoids a second store that could disagree with the first. The Task tree already holds children, waits and Questions. The backpack adds only what has arrived but has not been handled.

Routine progress stays out of the wake because a turn per update would spend the budget on reading status. It still reaches the screens at once and the hob in its next turn.

## Consequences

- The [backpack contract](../architecture/inbox.md) becomes decided, under the new word. It points here for kinds, states, keys and claims.
- The [execution lifecycle](../architecture/execution-lifecycle.md) gains the dispatcher in its transition table and recovery sequence, and its command idempotency section is decided.
- ADR 018's out-of-scope line for continuations now points here.
- The chat service stops starting queued messages itself. Its drain after a turn, after a restart and on wake calls the dispatcher.
- The approval waiter becomes the dispatcher's live-turn branch. An approval request still expires at boot, as ADR 015 decides.
- Slice 10's done-when "thirty progress updates cause one continuation, not thirty" is sharpened: routine progress causes no continuation on its own, and thirty updates reach the hob as one digest in its next turn.
- #273 and #274 depend on the dispatcher ([#292](https://github.com/otaviobarros/hobbots/issues/292)) to wake the lead.
- How a continuation and a hob's backpack show on screen is designed with [#292](https://github.com/otaviobarros/hobbots/issues/292) and [#297](https://github.com/otaviobarros/hobbots/issues/297).
- Lease length, retry count and retention keep their defaults above and stay configurable ([open questions](../product/open-questions.md)).

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- An item is committed in the same transaction as the change that caused it, and the same tool call or hub change retried makes no second item: `[TC-IN-020]`, `[TC-IN-021]` and `[TC-IN-022]` on SQLite and PostgreSQL ([#290](https://github.com/otaviobarros/hobbots/issues/290)). Its states move only through legal steps under a live claim, a write under another owner, an older token or a lapsed lease is refused, and expiring a claim raises its token: `[TC-IN-023]`, `[TC-IN-024]`. A hob's, a Quest's and the workspace's open items read with a cursor: `[TC-IN-025]`, `[TC-IN-026]`.
- Delivering the same item twice creates no second Task, message or effect: `[TC-IN-027]` on SQLite and PostgreSQL, with an effect keyed by the item through the hob tools' ledger ([#291](https://github.com/otaviobarros/hobbots/issues/291)). Each delivery is recorded apart from its acknowledgement, a turn that ends early is retried with backoff, and an item whose retries run out fails: `[TC-IN-028]`.
- A worker whose lease expired cannot apply or renew its outcome, both before another worker claims the item and after; a claim expired at boot is refused the same way: `[TC-IN-024]`, `[TC-IN-029]`, `[TC-IN-030]`, `[TC-IN-031]` for an effect committed after its claim expired, and `[TC-IN-032]` for a renewal while an effect commits, on PostgreSQL too ([#291](https://github.com/otaviobarros/hobbots/issues/291)).
- A late result from a cancelled or reassigned Task resolves as late and starts nothing: `[TC-OR-040]` for a cancelled Task; a reassigned one by unit test only, since nothing reassigns a Task yet ([#291](https://github.com/otaviobarros/hobbots/issues/291), [#276](https://github.com/otaviobarros/hobbots/issues/276)).
- A result arriving after the lead's turn ended starts one continuation without you prompting: `[TC-OR-080]`. Queued chat messages still start first, with the work riding along: `[TC-OR-081]`. A paused hob keeps what arrived and continues once it wakes: `[TC-OR-082]`. A request whose turn a restart ended reaches its hob as an Approval outcome: `[TC-OR-083]`. A continuation you stop does not start again on its own and rides along your next message: `[TC-OR-084]`. Work that arrives while a wake finds nothing still starts once the thread is free: `[TC-OR-085]`. Every waiting item goes into one turn, planned again after an early end: `[TC-IN-060]` ([#292](https://github.com/otaviobarros/hobbots/issues/292)). An approval outcome still reaches its live turn through the approval waiter, not yet through a backpack item.
- What a member holds under its Task, such as a hand-off from its lead, continues the member's own session, never a thread, and a party's results start the lead's continuations until it wraps up: `[TC-IN-061]`, `[TC-OR-090]` ([#273](https://github.com/otaviobarros/hobbots/issues/273)).
- Thirty progress updates start no turn and reach the lead as one digest, a line per Task, in the continuation the next actionable item starts: `[TC-OR-100]`; progress alone rides along your next message instead and is consumed by it: `[TC-OR-101]`; a turn that carried only progress and ended early, or that you stopped, fails none of it and holds nothing back: `[TC-OR-102]`; progress rides along the retry its batch's other work plans and alone plans none: `[TC-IN-071]`; the digest itself: `[TC-IN-070]` ([#293](https://github.com/otaviobarros/hobbots/issues/293)).
- The completion gate refuses a Task with an unresolved backpack item or an open child, from the same ledger query, and completing a Quest with a member's result unread is refused and names that result: `[TC-IN-040]`, `[TC-OR-050]` ([#294](https://github.com/otaviobarros/hobbots/issues/294)).
- A hob completes a delegated Task from the turn its Task item started: the gate passes, and that item resolves as consumed in the same transaction. An item that arrived during the turn without being delivered to it still blocks, and a carried item whose claim lapsed or moved on blocks too: `[TC-IN-041]`, `[TC-IN-042]`; answers, hand-offs and unreached milestones on the paths that run today: `[TC-OR-051]`, `[TC-OR-052]`, `[TC-OR-053]`; a result or hand-off that lands between reading a turn's prompt and its ledger is never settled unread, and the steps of a hob's own steps reach its briefing: `[TC-OR-054]`, `[TC-OR-055]`, `[TC-OR-056]` ([#294](https://github.com/otaviobarros/hobbots/issues/294)).
- Restarting between a child finishing and its lead being notified loses nothing, and the earlier process's claims are expired at boot: a result that has not reached its lead starts its continuation after the stop, `[TC-OR-110]`; a continuation the stop cut off runs again under a new fencing token while its earlier claim is refused, `[TC-OR-111]`; a step the stop cut off fails and its lead hears of it, `[TC-OR-112]`. A step whose session ended just before the stop, or that waits for a step of its own, also ends, `[TC-OR-113]`, `[TC-OR-116]`; a step being cancelled is cancelled with the Task above it, `[TC-OR-114]`; and a step that completed before its Attempt ended keeps its result, `[TC-OR-115]` ([#295](https://github.com/otaviobarros/hobbots/issues/295)).
- Exhausted retries and a retired recipient end in a failed item with a blocker and a next action, which you retry or dismiss: `[TC-IN-090]` to `[TC-IN-095]`, with `[TC-IN-094]` for a choice bound to its blocker, on SQLite and PostgreSQL, `[TC-OR-120]` for turns cut off, `[TC-OR-121]` for work you stopped, `[TC-OR-122]` for a retired hob, and `[TC-IN-096]` to `[TC-IN-098]` in the browser ([#296](https://github.com/otaviobarros/hobbots/issues/296)). Reassign waits for Task reassignment ([#311](https://github.com/otaviobarros/hobbots/issues/311)).
- A member's finished result shows in the lead's hob panel and in the Quest tab as awaiting the lead, with its state, until the lead's continuation consumes it: `[TC-IN-150]` ([#297](https://github.com/otaviobarros/hobbots/issues/297)).
- The whole slice runs end to end with an evidence record: not proven yet, [#298](https://github.com/otaviobarros/hobbots/issues/298).

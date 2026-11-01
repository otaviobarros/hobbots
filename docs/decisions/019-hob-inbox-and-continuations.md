# ADR 019 — A hob's inbox and continuations

Status: **Accepted.** Refines [ADR 004](004-durable-inbox.md), the [inbox contract](../architecture/inbox.md), the [execution lifecycle](../architecture/execution-lifecycle.md) and [ADR 018](018-tasks-and-quests.md) for Slice 10 ([#11](https://github.com/otaviobarros/hobbots/issues/11)).

## Context

ADR 004 decided that results, questions and promises are durable and that a hob continues when they arrive. The inbox contract drafted the states and the delivery steps but left the transaction, the keys and the wake open.

Three pieces on `main` already do part of the job, each in its own way:

- **The chat queue.** Queued messages start when a thread's turn ends, after a restart and when a paused hob wakes (CH-008). The trigger lives in the chat service.
- **The approval wake.** A decision on a tool call resumes the turn that waits for it, through an in-memory waiter. A request whose turn died with the process expires at boot ([ADR 015](015-approval-lifetimes-and-grants.md)).
- **The event journal.** It records every change in the same transaction ([ADR 013](013-event-journal.md)), but nothing tracks that a hob still has to act on one.

Slice 9 adds hob tools ([#271](https://github.com/otaviobarros/hobbots/issues/271)) whose results, questions and hand-offs must reach a lead whose turn has often ended. Adding a third trigger for them would leave three wake paths with three sets of recovery rules.

"Inbox" is also already your page: approvals and questions that need you (screen 8). A hob's queue must never be mistaken for it.

## Decision

### The name

A hob's durable queue is its **inbox**, and an entry in it is an **inbox item**. It holds what a hob still has to act on: results to read, questions to answer, answers to its own questions, hand-offs and deadlines. The word stays plain on purpose: a themed name would be one more thing to learn.

The two inboxes are told apart by whose they are, never by a second word:

- **Your Inbox** is what needs *you*: approval requests and questions no lead could answer. It is unchanged.
- **A hob's inbox** is what needs *that hob*. It is always named with its hob ("Aldric's inbox") and never shown as "Inbox" alone. You can look into it, but you never work it.
- An escalated question is a Question record that shows in your Inbox. Your answer becomes an inbox item for the hob that asked.

Code, docs and UI use the same words: `InboxItem` in `@hobbots/inbox`. Your Inbox keeps showing approval requests and Questions from their own records.

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
| Resolved | Handled | A disposition: `consumed` with the turn that ended, `answered` with the tool call, `late` with the Task version it was checked against, or `dismissed` with who dismissed it |
| Failed | Delivery or processing exhausted its retries, or the recipient can no longer take it | The error, every attempt, and the blocker with its next action (IN-007) |

Inactivity is never acknowledgement. Only the adapter's own evidence moves an item to Acknowledged. An item whose turn ends early, by interruption, a crash or a runtime failure, goes back to Pending with a new attempt. It never counts as resolved.

### Idempotency keys

Every item has a dedupe key. The inbox stores at most one item per recipient and key, and a second insert with the same pair changes nothing.

- **From a hob tool call.** The key is the tool call's own idempotency key from #271, scoped to the calling hob and the tool, plus the item's role in that call. For example `complete_task` by Quill makes `tool:<quill>:complete_task:<key>:result`. A retried call therefore makes no second item.
- **From a hub change.** The key is the source record's id and the version that caused it: `task:<id>:v<version>`, `approval:<id>:decided`, `deadline:<wait id>`.
- **From your command.** Answers and notes reuse the command's idempotency key from the client.

The processing side deduplicates by item id. Any effect an item causes, such as a Task change, carries the item id, so applying it twice finds the first result.

**Retention.** An item and its key stay while the top Task is open and for 30 days after it ends. Items outside any Task stay for 30 days after they resolve. Both windows are configurable. A duplicate that arrives after its item was removed is checked against the source record, which has ended by then, and is recorded as late, not applied.

### Claims, leases and fencing tokens

A worker claims an item before it delivers it, and holds the claim until the item resolves or goes back to Pending.

- A claim records its owner (the hub process and the turn), a **lease** with an expiry, and a **fencing token**. The token is an integer that grows by one on every claim of that item.
- The worker renews the lease while the turn runs, on the turn's text checkpoint cadence ([ADR 013](013-event-journal.md)). The default lease is 60 seconds and is configurable.
- Every write that applies an item's outcome includes `fence = <token>` as an expected value, in the same transaction as the change. A worker whose lease expired holds a lower token, so its write changes nothing. It discards the outcome and logs it.
- At boot every claim held by an earlier process is expired at once, because its turns are gone.

The same rule works on SQLite and PostgreSQL, because it needs only a conditional update.

### One wake path: the dispatcher

Every turn that you did not start with Send is started by one **dispatcher**. It replaces the chat queue's own trigger and the approval wake. It is not a third path.

- **Targets.** An item goes to the session that owns its Task: the top Task's thread for that Task's owner, or the current Attempt's session for a member's Task or a step. An item outside any Task goes to its thread.
- **Live turn first.** When a running turn waits for the item, as a tool call waits for its approval, the dispatcher delivers it into that turn. No new turn starts. Today's approval waiter becomes this branch.
- **Otherwise a continuation.** When the target is idle, the dispatcher starts one turn that carries every pending actionable item for that target, with the routine digest. Thirty items make one turn.
- **Your words come first.** Queued chat messages stay messages (CH-008) and are not copied into the inbox. When a thread has a queued message, it starts first, and the pending items ride along in the same turn as context.
- **Busy target.** Items wait. When the running turn ends, it asks the dispatcher for the next turn instead of draining its own queue.
- **Gates.** The dispatcher starts a turn only when the hob is active, within its concurrency limits and budget, and still owns or leads the Task. A paused hob keeps its items until it wakes. A retired hob's items fail, and its lead gets a Failure item with a next action.
- **Triggers.** The dispatcher runs after a commit that adds an item, when a turn ends, when a hob wakes, when a not-before time passes, and at boot. The publish after commit only wakes it. The stored items decide what runs, as the journal does for the event stream.

A continuation's prompt is written by Hobbots and says so. It lists each item with who sent it and why, and it is never shown as a message from you.

### Late results

An item for a Task that was cancelled or reassigned is still recorded. When it is processed, the dispatcher checks it against the Task's current owner and version. If the recipient no longer owns or leads the Task, or the Task has ended, the item resolves as `late` and starts nothing. A late result stays on the Task as a late Attempt outcome, so it can still be inspected ([#276](https://github.com/otaviobarros/hobbots/issues/276), handled in [#291](https://github.com/otaviobarros/hobbots/issues/291)).

### The responsibility ledger is a read

The responsibility ledger is a query, not a table. It reads the Task tree and the inbox together: open child Tasks, wait records, unanswered Questions, milestones not reached, promised artifacts, pending approvals, and inbox items not yet resolved. `complete_task`'s completion gate from #271 and a Quest's closure call the same query.

### The delivery seam in the hob tools

#271 keeps delivery behind one seam so it builds no wake of its own. The seam is a pure function: given the journal events a change produces, it returns the inbox items to record. The repository writes those items in the same transaction as the change and its events, exactly as it writes journal events. Until [#290](https://github.com/otaviobarros/hobbots/issues/290) adds the inbox records, the seam returns nothing.

### Events

Two journaled events let the screens follow the inbox: `InboxItemRecorded` when an item is committed, and `InboxItemChanged` when its state changes. Routine items may be coalesced before they are journaled ([ADR 013](013-event-journal.md)).

### Retries

Delivery retries with bounded backoff. The default is three attempts per item and is configurable. When the attempts run out, the item fails with a blocker and a next action ([#296](https://github.com/otaviobarros/hobbots/issues/296)).

## Rationale

"Inbox" is the word people already know for things waiting to be handled, and the requirements, ADR 004 and the package already use it. Naming the owner every time keeps the two apart without a themed word anyone has to learn.

One dispatcher means one place that decides when a hob runs, with one set of gates and one recovery at boot. The chat queue and the approval wake already solve small cases of the same problem. Folding them in removes two ad hoc triggers instead of adding a third.

Reusing #271's idempotency keys puts the dedupe at the source. A retried tool call and a redelivered item both land on the same row, so neither can make a second Task or effect. Fencing tokens are the standard guard against a paused or partitioned worker that wakes up after its lease ran out, and a conditional update is enough on both databases.

Reading the ledger from the Task tree avoids a second store that could disagree with the first. The Task tree already holds children, waits and Questions. The inbox adds only what has arrived but has not been handled.

Routine progress stays out of the wake because a turn per update would spend the budget on reading status. It still reaches the screens at once and the hob in its next turn.

## Consequences

- The [inbox contract](../architecture/inbox.md) becomes decided. It points here for kinds, states, keys and claims.
- The [execution lifecycle](../architecture/execution-lifecycle.md) gains the dispatcher in its transition table and recovery sequence, and its command idempotency section is decided.
- ADR 018's out-of-scope line for continuations now points here.
- The chat service stops starting queued messages itself. Its drain after a turn, after a restart and on wake calls the dispatcher.
- The approval waiter becomes the dispatcher's live-turn branch. An approval request still expires at boot, as ADR 015 decides.
- Slice 10's done-when "thirty progress updates cause one continuation, not thirty" is sharpened: routine progress causes no continuation on its own, and thirty updates reach the hob as one digest in its next turn.
- #273 and #274 depend on the dispatcher ([#292](https://github.com/otaviobarros/hobbots/issues/292)) to wake the lead.
- How a continuation and a hob's inbox show on screen is designed with [#292](https://github.com/otaviobarros/hobbots/issues/292) and [#297](https://github.com/otaviobarros/hobbots/issues/297).
- Lease length, retry count and retention keep their defaults above and stay configurable ([open questions](../product/open-questions.md)).

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- An item is committed in the same transaction as the change that caused it, and the same tool call or hub change retried makes no second item: not proven yet, [#290](https://github.com/otaviobarros/hobbots/issues/290).
- Delivering the same item twice creates no second Task, message or effect, and a worker whose lease expired cannot apply its outcome: not proven yet, [#291](https://github.com/otaviobarros/hobbots/issues/291).
- A late result from a cancelled or reassigned Task resolves as late and starts nothing: not proven yet, [#291](https://github.com/otaviobarros/hobbots/issues/291).
- A result arriving after the lead's turn ended starts one continuation without you prompting, queued chat messages still start first, and an approval outcome reaches its live turn without a new one: not proven yet, [#292](https://github.com/otaviobarros/hobbots/issues/292).
- Thirty progress updates start no turn and reach the lead as one digest: not proven yet, [#293](https://github.com/otaviobarros/hobbots/issues/293).
- The completion gate refuses a Task with an unresolved inbox item or an open child, from the same ledger query: not proven yet, [#294](https://github.com/otaviobarros/hobbots/issues/294).
- Restarting between a child finishing and its lead being notified loses nothing, and the earlier process's claims are expired at boot: not proven yet, [#295](https://github.com/otaviobarros/hobbots/issues/295).
- Exhausted retries and a retired recipient end in a failed item with a blocker and a next action: not proven yet, [#296](https://github.com/otaviobarros/hobbots/issues/296).
- The whole slice runs end to end with an evidence record: not proven yet, [#298](https://github.com/otaviobarros/hobbots/issues/298).

# ADR 019 — A hob's backpack and continuations

Status: **Accepted.** Refines [ADR 004](004-durable-inbox.md), the [inbox contract](../architecture/inbox.md), the [execution lifecycle](../architecture/attempt-lifecycle.md) and [ADR 018](018-tasks-and-quests.md) for Slice 10 ([#11](https://github.com/otaviobarros/hobbots/issues/11)). Amended by [#1345](https://github.com/otaviobarros/hobbots/issues/1345): a lead's message can reach its member's running turn at that turn's next step, or stop the turn and start the next one with it (see [Messages to a running turn](#messages-to-a-running-turn)).

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
- **Busy target.** Items wait. When the running turn ends, it asks the dispatcher for the next turn instead of draining its own queue. A lead's message to its member's running turn is the exception: see [Messages to a running turn](#messages-to-a-running-turn).
- **Gates.** The dispatcher starts a turn only when the hob is active, within its concurrency limits and budget, and still owns or leads the Task. A paused hob keeps its items until it wakes. A retired hob's items fail, and its lead gets a Failure item with a next action.
- **Triggers.** The dispatcher runs after a commit that adds an item, when a turn ends, when a hob wakes, when a not-before time passes, and at boot. The publish after commit only wakes it. The stored items decide what runs, as the journal does for the event stream.

A continuation's prompt is written by Hobbots and says so. It lists each item with who sent it and why, and it is never shown as a message from you.

### Messages to a running turn

Amended in [#1345](https://github.com/otaviobarros/hobbots/issues/1345). A running turn no longer reads only what it started with. A lead's `message_task` says how its note reaches a member whose turn runs as it arrives, and the note keeps it as its `delivery`:

- **`steer`, the default.** The note reaches the turn at its next step, between two tool calls and never inside one. This is the live-turn branch above: the dispatcher claims the note's Message item for the running turn and records it as delivered into that turn's Attempt. The runtime adapter hands it to the model in its own way. Claude Code adds it to the result of the call that just ended, through its PostToolUse hook. Codex adds it to the running turn with `turn/steer`, and holds a hub call's answer until Codex has it, so the model reads it with the request that carries that answer. Only when the runtime took it does the item move to Acknowledged, with the turn's session, which records the pick-up on the note. It then resolves as `consumed` by that turn at once, since the turn has read it. While the runtime takes it, the dispatcher renews the claim as it does for a turn it runs, so a runtime slow to answer never lets the lease lapse and the note be delivered twice. A turn that waits for your approval keeps its card: its call ends once you decide, and the note follows it.
- **`interrupt`.** The turn stops as a stop by Hobbots does: its Attempt ends as interrupted, its Task waits, and its items go back to pending. The next turn goes on in the same Attempt and session, and carries the note first in its prompt.
- **`next-turn`.** The note waits for the turn to end, as any item does for a busy target.

A runtime that cannot add input to a running turn says so (`steersTurns` false on its adapter), and a `steer` to it interrupts instead, which `message_task` tells the lead. Claude Code, Codex and the fake runtime all can.

A note that misses the turn waits for the next one. That is a note handed to a turn that ended before its runtime took it, which goes back to pending, as does one whose hand-off is interrupted, and a note for a turn that has no step left, which is never handed to it. A member with no turn running gets the note with its next turn whichever delivery was asked.

What happens stays on the Task. The note records when it was sent (`createdAt`), how it was asked to arrive (`delivery`), and which turn it reached and when (`pickedUpBy`, `pickedUpAt`), and the journal records `NoteLeft` and `NotePickedUp`. Its item's deliveries record each hand-off and the session that took it.

The bus still only wakes things up (STD-ARCH-017). When a Message item for a running member's Task is recorded, the runner reads what the waiting messages ask: it stops the turn for an `interrupt`, and wakes the turn for a `steer`. The turn reads the backpack again at its next step to find what to hand over. Nothing waits in a second queue.

### Late results

An item for a Task that was cancelled or reassigned is still recorded. When it is processed, the dispatcher checks it against the Task's current owner and version. If the recipient no longer owns or leads the Task, or the Task has ended, the item resolves as `late` and starts nothing. A late result stays on the Task as a late Attempt outcome, so it can still be inspected ([#276](https://github.com/otaviobarros/hobbots/issues/276), handled in [#291](https://github.com/otaviobarros/hobbots/issues/291)).

A late item needs no turn to settle. A turn that ends early, stopped or interrupted, checks its items against their Tasks again before it sends any back to pending, so the items a turn carried when its Task was cancelled resolve as late as the turn ends. An item found late before a turn is planned resolves as late at once, even where no turn can start now. And once a Task is cancelled or its cancel is asked for, or the Task you asked for ends, the hub resolves as late every unclaimed item about that Task or a Task under it that is late by then, routine progress included, since no turn may ever come for it. Work held under a member's failed Task that can still be retried stays for the retry, and so does the work of the Task's siblings. So once a cancelled Quest's Tasks have confirmed they stopped, nothing about it waits in any backpack ([#396](https://github.com/otaviobarros/hobbots/issues/396)).

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
- The [execution lifecycle](../architecture/attempt-lifecycle.md) gains the dispatcher in its transition table and recovery sequence, and its command idempotency section is decided.
- ADR 018's out-of-scope line for continuations now points here.
- The chat service stops starting queued messages itself. Its drain after a turn, after a restart and on wake calls the dispatcher.
- The approval waiter becomes the dispatcher's live-turn branch. An approval request still expires at boot, as ADR 015 decides.
- Slice 10's done-when "thirty progress updates cause one continuation, not thirty" is sharpened: routine progress causes no continuation on its own, and thirty updates reach the hob as one digest in its next turn.
- #273 and #274 depend on the dispatcher ([#292](https://github.com/otaviobarros/hobbots/issues/292)) to wake the lead.
- How a continuation and a hob's backpack show on screen is designed with [#292](https://github.com/otaviobarros/hobbots/issues/292) and [#297](https://github.com/otaviobarros/hobbots/issues/297).
- Lease length, retry count and retention keep their defaults above and stay configurable ([open questions](../product/open-questions.md)).

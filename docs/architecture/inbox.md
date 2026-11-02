# A hob's backpack and continuations

**Decided** ([ADR 004](../decisions/004-durable-inbox.md), [ADR 019](../decisions/019-hob-backpack-and-continuations.md)). Each hob has a durable **backpack** of responsibilities, not merely a notification list. A **backpack item** is one thing the hob still has to act on.

A hob's backpack is not your Inbox. Your Inbox holds what needs you: approval requests and questions no lead could answer. A hob's backpack holds what needs that hob. Your answer to an escalated question becomes a backpack item for the hob that asked.

## Item kinds

Kinds are Task, result, failure, checkpoint (milestone, finding or blocker), question, answer, hand-off, message, approval outcome, deadline and progress. [ADR 019](../decisions/019-hob-backpack-and-continuations.md#item-kinds) says who makes each and who receives it.

Every kind except progress is **actionable** and can wake the hob. Progress, including the hub's started and waiting states, is **routine**. It updates the screens at once and reaches the hob as a digest in its next turn, but never wakes it on its own (IN-005). Deadline reminders support existing work; this does not introduce the deferred general recurring-automation product.

## Processing lifecycle

| State | Meaning | Durable evidence |
|---|---|---|
| Pending | Committed with the change that caused it, waiting for a turn | Item ID, recipient, kind, actionable or routine, Task and Quest IDs, correlation, dedupe key, payload, creation time, not-before time for deadlines. |
| Delivered | Put into a turn: a continuation's prompt, or a live turn's waiting tool call | Delivery attempt with its target, turn and runtime session. |
| Acknowledged | The runtime accepted the turn that carries it | The adapter's start evidence for that turn. |
| Processing | The turn is running and holds the item's claim | Claim owner, fencing token and lease expiry. |
| Resolved | Handled | Disposition: consumed by a turn, answered by a tool call, late, or dismissed. |
| Failed | Retries exhausted, or the recipient can no longer take it | Error, every attempt, and a blocker with its next action. |

Adapters and Hobbots services record real evidence. Inactivity is not acknowledgement. An item whose turn ends early goes back to Pending with a new attempt; it never counts as resolved.

## Records

The backpack is built in `@hobbots/inbox`, `@hobbots/persistence` and migration 0026 ([#290](https://github.com/otaviobarros/hobbots/issues/290)), and delivery in `@hobbots/inbox` ([#291](https://github.com/otaviobarros/hobbots/issues/291)). Nothing calls delivery to wake a hob yet ([#292](https://github.com/otaviobarros/hobbots/issues/292)).

- **`BackpackItem`** (`@hobbots/domain`): recipient, kind, actionable, priority, state, the Task, Quest, Attempt and thread it belongs to, dedupe key, payload, not-before time, claim, fencing token, deliveries, disposition and error. Its `questId` is the nearest Quest above its Task, the one whose lead runs the work.
- **`backpackItemsFor`** (`@hobbots/inbox`): the pure rule that turns a change's journal events into items. The repositories call it inside every journaled change, so the hob tools need no change. Routine progress is recorded too; it is not actionable. The hub's own ending checkpoints make no item, because the result or failure says it.
- **`Backpack`** (`@hobbots/inbox`, `BackpackLive` in `@hobbots/persistence`): claim, renew, deliver, acknowledge, process, requeue, resolve, fail, expire claims, and run an effect fenced by the claim, plus reads of a hob's, a Quest's and the workspace's open items. Every step after the claim checks the owner, the token, the lease by the database's clock and the step's starting states in one conditional update. A refused step writes nothing.
- **Tables:** `backpack_items`, unique on recipient and dedupe key, holds the claim's owner, token and lease; `backpack_deliveries` keeps each delivery with the token it was made under and the runtime's acknowledgement.
- **`Dispatcher`** (`@hobbots/inbox`): delivers one item into a turn the caller describes. It claims the item first, so an item already settled or claimed is never delivered again. It checks the item against its Task and resolves it as late without a turn when the Task it is checked against has ended or its recipient no longer owns it. Otherwise it records the delivery, moves the item to acknowledged and processing only on the session the runtime reported, renews the lease every third of it while the turn runs, and resolves the item as consumed when the turn ends. The turn commits each of the item's effects through the delivery, keyed by the item, in a transaction that first checks the claim still holds; the last effect can resolve the item in the same transaction. An effect whose claim was lost writes nothing. A claim's owner is the hub process and the turn. A turn that ends early, fails, dies or is interrupted sends the item back to pending, and it is retried with backoff; the third delivery by default fails it instead. A turn whose claim is lost is stopped and its outcome dropped. A deadline is not delivered before its not-before time. At start the dispatcher expires every claim an earlier process held, then expires lapsed claims once per lease. Its Task trees and event publishing come from the hub through `DispatcherHost`.
- **Events:** `BackpackItemRecorded` follows the change's own events in the same transaction, and `BackpackItemChanged` records every later step.

| Item kind | Made from | Recipient |
|---|---|---|
| Task | `TaskCreated` for a step or a delegated Task | The new Task's owner |
| Result | `TaskCompleted` | The parent Task's owner |
| Failure | `TaskStateChanged` to failed, blocked or cancelled | The parent Task's owner |
| Checkpoint | `CheckpointRecorded` for a milestone, finding, blocker or question | The nearest lead |
| Progress | `CheckpointRecorded` for progress, started or waiting | The nearest lead |
| Question | `QuestionAsked`, `QuestionEscalated` | The lead it is with; none once it reaches you |
| Answer | `QuestionAnswered` | The hob that asked |
| Hand-off | `HandedOff` | The receiving Task's owner |

Messages, approval outcomes and deadlines have their kinds and payloads but no source yet. They come with the commands and the dispatcher that make them.

## Delivery and recovery

1. Commit the item in the same transaction as the change that caused it. The backpack row is the outbox.
2. A dispatcher claims the item with a lease and a fencing token, then delivers it with stable identity and correlation. Delivery is at least once.
3. Record acknowledgement separately from delivery.
4. Deduplicate by item ID and dedupe key before applying any effect.
5. Persist the outcome and linked Task changes in one transaction, guarded by the fencing token.
6. Queue the next continuation or outgoing item durably; publish UI updates after commit.

Each item has a dedupe key, unique per recipient. Keys reuse the hob tools' idempotency keys, the source record's id and version, or your command's key. An outcome write checks the token, the claim's owner and the lease's expiry in one conditional update. Expiring a claim clears its owner and raises its token in one update, so a worker whose lease expired is refused at once, before any other worker claims the item. Retry transport failures with bounded backoff. For effects outside the database, use provider idempotency where available and reconcile unknown outcomes before retry. [ADR 019](../decisions/019-hob-backpack-and-continuations.md) sets the key scope, retention, lease and retry defaults.

Items for a cancelled or reassigned Task are recorded, checked against the Task's current owner and version, and resolved as late. They never restart work.

## The dispatcher

One dispatcher starts every turn that you did not start with Send. It replaces the chat queue's own trigger and the approval wake.

- An item goes to the session that owns its Task: the top Task's thread for its owner, or the current Attempt's session for a member's Task or a step.
- A live turn waiting for the item, such as a tool call waiting for its approval, gets it in place.
- An idle target gets one continuation that carries every pending actionable item, with the routine digest.
- Queued chat messages stay messages and start first; pending items ride along in the same turn.
- A turn starts only when the hob is active, within its limits and budget, and still owns or leads the Task. A paused hob keeps its items. A retired hob's items fail with a next action for its lead.

An ended parent turn does not discard the continuation obligation. A continuation's prompt is written by Hobbots and is never shown as a message from you.

## Responsibility ledger

The responsibility ledger is a read over the Task tree and the backpack, not a separate store. For a Task it lists, in this order: Tasks under it that have not ended, its wait while the wait still holds, sibling Tasks it comes after that have not completed, unanswered questions on it or under it, the milestones it promised and has not reached, approval requests still pending and unexpired in its thread (for the request's top Task, which chat turns work on), and its owner's actionable backpack items about it or a Task under it that are not yet resolved or failed. Milestones are the promised outputs the hub can check; a Delegation's expected output is free text for the member and is not checked. A question shows once, as its Question record, not again as the lead's backpack item. Once a Task under it has ended, only that Task's result or failure still has to be read; its Task item, hand-offs, answers and reports have nothing left to act on, and completing the Task resolves those still pending and unclaimed as `late`. Routine progress never blocks. A supervisor can detect unfinished work without asking the model for status: `GET /api/tasks/:taskId/ledger` reads it. The completion gate and Quest closure use the same query. The gate never starts work: it refuses, and the refusal names the first eight open entries, in the order above, and counts the rest, so the hob can act on them in the same turn and the full list stays one ledger read away. A step whose final reply cannot complete it fails with a blocker checkpoint that says what was left open.

The gate leaves out the items the completing turn carries, and a successful completion resolves them as `consumed` in the same transaction. A carried item counts only while the turn's claim on it holds, by owner, fencing token and lease, or, for an item the turn was briefed with before any worker claimed it, while it is still pending, unclaimed and at the fencing token the turn saw. Until the dispatcher delivers items ([#292](https://github.com/otaviobarros/hobbots/issues/292)), a step's session carries its own Task item and the hand-offs its prompt shows, and a chat turn carries what its briefing shows: the results and failures of the Tasks under its Task, and under its own steps at any depth, since those come back to the same hob, and the answers to the questions its hob asked about it. A turn carries an item only when the tree its prompt was made from shows the record at the version the item was recorded from or later, and only hand-offs that tree holds, so an item that arrives between reading the tree and reading the ledger is never consumed unread. Any other item, such as one that arrived during the turn, still blocks until a later turn carries it.

## User visibility

Support current-hob, current-Quest and workspace-wide views of what hobs are waiting on in the execution surface. Show who owns a pending item, when it began, its delivery, acknowledgement and processing state, and available interventions. Completed child work stays a pending result in the lead's backpack until the lead actually handles it. The screens are designed with [#297](https://github.com/otaviobarros/hobbots/issues/297).

Verify result arrival while busy, inactive parent sessions, crash after commit and before delivery, duplicate delivery, out-of-order events, expired processing lease, exhausted retries and disabled recipients. No case may silently discard responsibility.

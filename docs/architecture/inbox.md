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
- **`Backpack`** (`@hobbots/inbox`, `BackpackLive` in `@hobbots/persistence`): claim, renew, deliver, acknowledge, process, requeue, resolve, fail and expire claims, plus reads of a hob's, a Quest's and the workspace's open items. Every step after the claim checks the owner, the token, the lease by the database's clock and the step's starting states in one conditional update. A refused step writes nothing.
- **Tables:** `backpack_items`, unique on recipient and dedupe key, holds the claim's owner, token and lease; `backpack_deliveries` keeps each delivery with the token it was made under and the runtime's acknowledgement.
- **`Dispatcher`** (`@hobbots/inbox`): delivers one item into a turn the caller describes. It claims the item first, so an item already settled or claimed is never delivered again. It checks the item against its Task and resolves it as late without a turn when the Task it is checked against has ended or its recipient no longer owns it. Otherwise it records the delivery, moves the item to acknowledged and processing only on the session the runtime reported, renews the lease every third of it while the turn runs, and resolves the item as consumed when the turn ends. A claim's owner is the hub process and the turn. A turn that ends early, fails, dies or is interrupted sends the item back to pending, and it is retried with backoff; the third delivery by default fails it instead. A turn whose claim is lost is stopped and its outcome dropped. A deadline is not delivered before its not-before time. At start the dispatcher expires every claim an earlier process held, then expires lapsed claims once per lease. Its Task trees and event publishing come from the hub through `DispatcherHost`.
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

The responsibility ledger is a read over the Task tree and the backpack, not a separate store. It covers promised outputs, outstanding child work, questions awaiting answers, dependencies, pending approvals, unresolved backpack items and closure evidence. A supervisor can detect unfinished work without asking the model for status. The completion gate and Quest closure use the same query. The gate leaves out the items the calling turn holds a valid claim on, and a successful completion resolves them in the same transaction. It must respect configured budgets and genuine blockers rather than generate unbounded new work.

## User visibility

Support current-hob, current-Quest and workspace-wide views of what hobs are waiting on in the execution surface. Show who owns a pending item, when it began, its delivery, acknowledgement and processing state, and available interventions. Completed child work stays a pending result in the lead's backpack until the lead actually handles it. The screens are designed with [#297](https://github.com/otaviobarros/hobbots/issues/297).

Verify result arrival while busy, inactive parent sessions, crash after commit and before delivery, duplicate delivery, out-of-order events, expired processing lease, exhausted retries and disabled recipients. No case may silently discard responsibility.

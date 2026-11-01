# A hob's satchel and continuations

**Decided** ([ADR 004](../decisions/004-durable-inbox.md), [ADR 019](../decisions/019-hob-satchel-and-continuations.md)). Each hob has a durable **satchel** of responsibilities, not merely a notification list. A **satchel item** is one thing the hob still has to act on.

The satchel is not your Inbox. Your Inbox holds what needs you: approval requests and questions no lead could answer. A hob's satchel holds what needs that hob. Your answer to an escalated question becomes a satchel item for the hob that asked.

## Item kinds

Kinds are Task, result, failure, checkpoint (milestone, finding or blocker), question, answer, hand-off, message, approval outcome, deadline and progress. [ADR 019](../decisions/019-hob-satchel-and-continuations.md#item-kinds) says who makes each and who receives it.

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

## Delivery and recovery

1. Commit the item in the same transaction as the change that caused it. The satchel row is the outbox.
2. A dispatcher claims the item with a lease and a fencing token, then delivers it with stable identity and correlation. Delivery is at least once.
3. Record acknowledgement separately from delivery.
4. Deduplicate by item ID and dedupe key before applying any effect.
5. Persist the outcome and linked Task changes in one transaction, guarded by the fencing token.
6. Queue the next continuation or outgoing item durably; publish UI updates after commit.

Each item has a dedupe key, unique per recipient. Keys reuse the hob tools' idempotency keys, the source record's id and version, or your command's key. A worker whose lease expired holds a lower fencing token, so its write changes nothing. Retry transport failures with bounded backoff. For effects outside the database, use provider idempotency where available and reconcile unknown outcomes before retry. [ADR 019](../decisions/019-hob-satchel-and-continuations.md) sets the key scope, retention, lease and retry defaults.

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

The responsibility ledger is a read over the Task tree and the satchel, not a separate store. It covers promised outputs, outstanding child work, questions awaiting answers, dependencies, pending approvals, unresolved satchel items and closure evidence. A supervisor can detect unfinished work without asking the model for status. The completion gate and Quest closure use the same query. It must respect configured budgets and genuine blockers rather than generate unbounded new work.

## User visibility

Support current-hob, current-Quest and workspace-wide views of what hobs are waiting on in the execution surface. Show who owns a pending item, when it began, its delivery, acknowledgement and processing state, and available interventions. Completed child work stays a pending result in the lead's satchel until the lead actually handles it. The screens are designed with [#297](https://github.com/otaviobarros/hobbots/issues/297).

Verify result arrival while busy, inactive parent sessions, crash after commit and before delivery, duplicate delivery, out-of-order events, expired processing lease, exhausted retries and disabled recipients. No case may silently discard responsibility.

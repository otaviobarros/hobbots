# Durable inbox and proactive continuations

**Decided behavior; the transaction and delivery contract is a draft.** Each agent has a persistent inbox of responsibilities, not merely a chat notification list.

Kinds include task request, question/message, progress, result, failure, approval outcome, dependency deadline and runtime/system event. Deadline reminders support existing work; this does not introduce the deferred general recurring-automation product.

## Processing lifecycle

| State | Meaning | Durable evidence |
|---|---|---|
| Pending | Recorded and awaiting delivery | Stable item ID, recipient, payload, correlations, priority and creation time. |
| Delivered | Transport/session received it | Delivery attempt and receipt; consumption is still outstanding. |
| Acknowledged | Recipient accepted responsibility | Acknowledgement tied to item and recipient. |
| Processing | Claimed for handling | Claim owner/lease and processing attempt. |
| Resolved | Required handling completed | Result, reply, applied outcome or explicit disposition. |
| Failed | Handling failed/exhausted its policy | Error, retry evidence and visible next action. |

These are conceptual distinctions, not a claim that an existing runtime natively emits every state. Adapters and Hobbots services must record real evidence; inferred inactivity is not acknowledgement.

## Delivery and recovery

1. Persist the source event and inbox obligation before attempting delivery.
2. Dispatch with stable identity and correlation. Delivery is at least once.
3. Record recipient acknowledgement separately from delivery.
4. Claim processing with durable ownership; deduplicate before applying effects.
5. Persist handling/result and linked responsibility updates transactionally.
6. Queue any next continuation or outgoing result durably; publish UI updates after commit.

Retry transport failures with bounded backoff. Reclaim expired claims with fencing so a delayed worker cannot apply stale changes. Duplicate delivery must not duplicate a delegated task or approved external operation. For effects outside the database, use provider idempotency where available and reconcile unknown outcomes before retry.

## Supervisor behavior

Actionable results, failures, questions and relevant approval outcomes schedule the responsible agent when it has capacity and authority. Routine progress updates stream to the UI; coalesce related updates rather than starting one model turn per event. An ended parent turn does not discard the continuation obligation.

The responsibility ledger records promised outputs, outstanding child work, questions awaiting responses, dependencies, and closure evidence. A supervisor can detect unfinished work without repeatedly asking the model for status. It must respect configured budgets and genuine blockers rather than generate unbounded new work.

## User visibility

Support current-agent, current-Quest and workspace-wide inbox views in the execution surface. Show who owns a pending response, when it began, receipt/acknowledgement/consumption state, and available interventions. Completed child work can remain “result awaiting consumption” until the parent actually handles it.

Verify result arrival while busy, inactive parent sessions, crash after commit/before delivery, duplicate delivery, out-of-order events, expired processing lease, exhausted retries and disabled recipients. No case may silently discard responsibility.

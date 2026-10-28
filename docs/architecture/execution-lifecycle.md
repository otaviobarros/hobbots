# Execution lifecycle and recovery

**Decided:** explicit domain states, pure validated transitions, transactional Effect services, durable recovery, task/attempt separation. The transition contract below is conceptual; finalize schema names and exhaustive transition tables before implementation.

## Independent dimensions

- Task responsibility: queued, active, waiting on dependency/approval/input, blocked, completed, failed or cancelled.
- Execution attempt: queued, starting, running, completed, failed, interrupted or cancelled.
- Communication: delivery, acknowledgement and consumption states defined by the inbox.
- Observation certainty: verified or unverified/reconciling after lost contact.

A running attempt may coexist with a pending external question. A task may remain open after its current attempt ends. An executor disconnect is not proof of failure or cancellation. These distinctions must be preserved in storage and UI.

## Transition contract

| Current condition | Event | Required handling |
|---|---|---|
| Queued task | Dispatch authorized | Claim work and create attempt; then start runtime. |
| Starting attempt | Runtime accepts | Record running and runtime correlation. |
| Active task | Dependency/approval needed | Persist explicit wait/obligation; retain independent useful work where possible. |
| Waiting responsibility | Relevant result/decision | Record inbox item and schedule continuation when authorized/capable. |
| Running attempt | Runtime turn ends | Record attempt outcome; evaluate task obligations separately. |
| Active/waiting task | Completion requested | Validate children/questions/artifacts/approvals and final result before success. |
| Any cancellable work | Cancel requested | Persist request and propagate; distinguish requested from confirmed outcome. |
| Retryable failure | Retry authorized | Create a new attempt under bounded policy, preserving task identity. |
| Live attempt loses contact | Disconnect/restart | Mark observation unverified; reconcile before retrying uncertain effects. |
| Terminal work | Late event | Record/deduplicate and reconcile; never arbitrarily reopen it. |

Validate each command and persisted state through Effect Schema. Pure transition functions return a next state or typed domain failure. Effect services perform permission checks and expected-version transactional updates with event/outbox records. Only then perform external dispatch. Side effects never occur inside a pure reducer.

## Recovery sequence

On server startup, identify incomplete attempts, stale leases, pending outbox/inbox work and open responsibilities. Query authorized executors/adapters for live sessions and actual outcomes. Resume supported sessions, reconstruct context only when allowed and labeled, or surface a blocker when safe resumption cannot be established. Fence stale workers. Reschedule durable continuations and delivery obligations.

An external operation may finish just before a connection fails. Treat this as an unknown outcome requiring reconciliation, not proof that it is safe to repeat. Exactly-once side effects cannot be guaranteed merely by an event journal.

## Closure evidence

Success includes required outputs/artifacts, handled or explicitly disposed child work, no unanswered required questions, no blocking approvals, and a final report to the requester. The responsibility ledger makes each item inspectable. Terminal failure/cancellation records why the objective did not complete and what happened to children. Retry does not rewrite an old attempt into a new successful one.

## Verification cases

Illegal/stale transition; two workers claiming the same task; cancel racing completion; result arriving during parent execution; crash after result commit but before parent notification; UI disconnect; executor loss; unsupported resume; duplicate approval; late message to canceled work. Verify expected durable state and user-visible explanation in each case.


## Explicit command idempotency

Commands need stable idempotency keys for task creation, message sending and applying a human approval. Persist the accepted command/result association so reconnect/retry cannot create duplicate records or repeat an already-applied operation. Delivery deduplication alone does not satisfy this command-level requirement. Exact key scope and retention are design details.

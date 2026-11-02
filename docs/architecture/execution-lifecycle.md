# Execution lifecycle and recovery

**Decided:** explicit domain states, pure validated transitions, transactional Effect services, durable recovery, task/attempt separation, and one dispatcher for every turn you did not start ([ADR 019](../decisions/019-hob-backpack-and-continuations.md)). The transition contract below is conceptual; finalize schema names and exhaustive transition tables before implementation.

## Independent dimensions

- Task responsibility: queued, active, waiting on dependency/approval/input, blocked, completed, failed or cancelled.
- Execution attempt: queued, starting, running, completed, failed, interrupted or cancelled.
- Communication: the backpack item states (pending, delivered, acknowledged, processing, resolved, failed) defined by the [backpack contract](inbox.md) and [ADR 019](../decisions/019-hob-backpack-and-continuations.md).
- Observation certainty: verified or unverified/reconciling after lost contact.

A running attempt may coexist with a pending external question. A task may remain open after its current attempt ends. An executor disconnect is not proof of failure or cancellation. These distinctions must be preserved in storage and UI.

## Transition contract

| Current condition | Event | Required handling |
|---|---|---|
| Queued task | Dispatch authorized | Claim work and create attempt; then start runtime. |
| Starting attempt | Runtime accepts | Record running and runtime correlation. |
| Active task | Dependency/approval needed | Persist explicit wait/obligation; retain independent useful work where possible. |
| Waiting responsibility | Relevant result/decision | Commit a backpack item with the change; the dispatcher delivers it to a live turn that waits for it, or starts one continuation when the hob is authorized and has capacity. |
| Running attempt | Runtime turn ends | Record attempt outcome; evaluate task obligations separately. Items the turn carried resolve if it completed, or go back to pending if it ended early. The dispatcher picks the next turn. |
| Active/waiting task | Completion requested | Validate children/questions/artifacts/approvals, unresolved backpack items and final result through the responsibility ledger before success. |
| Any cancellable work | Cancel requested | Persist request and propagate; distinguish requested from confirmed outcome. |
| Retryable failure | Retry authorized | Create a new attempt under bounded policy, preserving task identity. |
| Live attempt loses contact | Disconnect/restart | Mark observation unverified; reconcile before retrying uncertain effects. A tool call recorded as started with no outcome is shown as uncertain and never run again automatically. |
| Terminal, cancelled or reassigned work | Late event | Record and deduplicate it, check it against the current owner and Task version, and resolve it as late; never reopen the Task or start a continuation. |

Validate each command and persisted state through Effect Schema. Pure transition functions return a next state or typed domain failure. Effect services perform permission checks and expected-version transactional updates with event/outbox records. Only then perform external dispatch. Side effects never occur inside a pure reducer.

## Recovery sequence

On server startup, identify incomplete attempts, stale leases, pending outbox and backpack work and open responsibilities. Query authorized executors/adapters for live sessions and actual outcomes. Resume supported sessions, reconstruct context only when allowed and labeled, or surface a blocker when safe resumption cannot be established. Expire every backpack claim the earlier process held, clearing its owner and raising its fencing token in one update, so a delayed worker cannot apply stale changes. End every Attempt left live as interrupted, then end every step that started and has not ended, with no live Attempt, deepest first, including one a stop between ending a step's session and ending the step leaves behind, so its result or failure reaches its lead. A reply cut off while it streamed is shown as interrupted and its running tool calls as uncertain. The dispatcher then reschedules pending items and queued chat messages through the same path it uses at any other time ([#295](https://github.com/otaviobarros/hobbots/issues/295)).

An external operation may finish just before a connection fails. Treat this as an unknown outcome requiring reconciliation, not proof that it is safe to repeat. Exactly-once side effects cannot be guaranteed merely by an event journal.

## Closure evidence

Success includes required outputs/artifacts, handled or explicitly disposed child work, no unanswered required questions, no blocking approvals, and a final report to the requester. The responsibility ledger makes each item inspectable. Terminal failure/cancellation records why the objective did not complete and what happened to children. Retry does not rewrite an old attempt into a new successful one.

## Verification cases

Illegal/stale transition; two workers claiming the same task; cancel racing completion; result arriving during parent execution; crash after result commit but before parent notification; UI disconnect; executor loss; unsupported resume; duplicate approval; late message to canceled work. Verify expected durable state and user-visible explanation in each case.


## Explicit command idempotency

**Decided** ([ADR 019](../decisions/019-hob-backpack-and-continuations.md#idempotency-keys)). Commands carry stable idempotency keys for task creation, message sending and applying a human approval. Persist the accepted command and result together so reconnect or retry cannot create duplicate records or repeat an already-applied operation. Delivery deduplication alone does not satisfy this command-level requirement.

- A hob tool call's key is scoped to the calling hob, and the same key with another tool, input or Task is refused. The backpack items it makes reuse that key, so a retried call makes no second Task, Question, hand-off or item.
- A hub change keys its items by the source record's id and version. Your answers and notes reuse the client command's key.
- Keys stay while the top Task is open and for 30 days after it ends, configurable. A duplicate after that is checked against the ended source record and recorded as late.

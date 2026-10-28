# Orchestration and responsibility

**Decided.** Every agent is a proactive worker. An orchestrator is an ordinary agent used for coordination, with no special runtime type. It can do its own work and delegate concurrently; any delegated agent can do the same within policy.

## Delegation contract

A request records delegation ID, Quest ID, parent task, sender, destination, objective/instructions, expected output, priority, context artifact references, permitted scope and timeout/budget policy. The server validates identity, authorization, capacity, depth/cycles and input schemas before dispatch. A child cannot gain authority by receiving more ambitious prose.

Expose controlled Hobbots tools such as `delegate_task`, `list_tasks`, `get_task`, `send_agent_message`, `wait_for_tasks`, `cancel_task` and `get_quest_status` through MCP or a supported equivalent adapter integration. These are Hobbots-level operations, not vendor method names. MCP is a transport/control boundary; it does not replace inbox durability or the scheduler.

Structured tasks/results coexist with conversational exchanges. Questions preserve sender, recipient and relevant task/delegation ID. A request to clarify a date range does not need a new Quest. Natural-language messages cannot bypass structural lifecycle and policy validation.

## Coordination loop

Receive objective/event → execute and delegate → track promises/dependencies → receive durable outcomes → reconcile remaining work → continue authorized work or expose a blocker → verify and report completion.

The parent may continue while children execute and may await any/all/a selected set of outcomes. Persist explicit waiting relationships, not heuristics based on silence. Show owner, expected return, elapsed time, acknowledgement, timeout and possible intervention. Active work and outstanding communication can coexist, so one flattened status is insufficient.

## Scheduling and limits

Bound active executions per executor, agent and Quest and enforce supported runtime session concurrency. Prevent delegation cycles and unlimited depth. Apply bounded retries, task deadlines and cost/usage limits where the runtime provides reliable usage data. Missing cost telemetry must be visible rather than presented as a precise budget guarantee.

Concurrency, depth, per-agent active tasks and task timeout defaults are open (for example three parallel tasks, depth two, two active tasks per agent, a fifteen-minute timeout). Exact fairness, batching, depth and timeout policies require resolution; make them configurable rather than hard-coded.

Cancellation/reassignment propagates as explicit commands and retains history. Late child results are reconciled against current ownership and task version. A canceled parent does not permit a delayed child event to restart unauthorized work. Partial useful results may be retained without misrepresenting success.

## Completion gate

Before successful closure, reconcile required child outcomes, unresolved questions, promised artifacts, blocking approvals and final result. A model saying “done” does not override the gate. If the objective cannot be met within authority, capability or limits, persist a blocked/failed outcome with evidence and an actionable explanation.

The core acceptance loop is Aldric → Rook → Sage/Pip, with independent work in flight, results arriving after a turn ends, automatic continuations, verification and final reporting. Run it across runtime boundaries and through injected restart/disconnection failures.


## Responsiveness and duration

The coordinating agent can respond to other user messages while delegated tasks continue. Serialize prompts only within a runtime session that requires it; do not block the entire agent or the whole workspace on a synchronous child call. Prefer live progress/events plus durable final results over unsolicited frequent chat turns. The exact progress batching cadence remains open; a final-result-only implementation would lose the locked visibility behavior.

Quest duration should be configurable with no universal hard cutoff, rather than a fixed maximum lifetime. Outstanding work still needs deadlines, budgets, stalled-state visibility and bounded retry behavior.

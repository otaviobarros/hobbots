# API, MCP and real-time events

**Decided:** Effect v4 typed HTTP API, schemas/typed errors, persisted events delivered with Effect Stream/SSE, and scoped MCP agent tools. Exact endpoints and payload schemas below are design contracts to finalize, not implemented APIs.

The browser and Electron submit commands to the same application services. Command areas include agent configuration, threads/prompts, Quests/tasks/delegations, inbox messages/acknowledgements, cancellations, approvals, executor registration and authorized artifact inspection. HTTP handlers validate input and identity; domain services validate authority and transitions.

Hobbots MCP exposes only permitted agent coordination capabilities: delegate, inspect assigned work, send correlated messages, wait for results and request cancellation/status. Credentials bind to an agent/execution and delegated scope. User administrative operations, credential management, human approval grants, administrative deletion and computer lifecycle operations are not exposed through agent-issued credentials. This excludes Hobbots control-plane administration; authorized workspace file operations remain subject to their separate resource/tool policy.

## Event envelope

Fields: event ID, schema version, durable sequence/cursor, timestamp, source, type, correlation identifiers (agent, thread, Quest, task, delegation, attempt, executor and runtime session as relevant), payload and causation/reference IDs. Validate inputs at boundaries; redact secrets before persistence.

Event families cover agent/thread/message creation and streaming; Quest/task lifecycle; delegation request/acceptance/message/result; execution start/output/outcome; tool start/output/completion; approval request/resolution; executor connect/disconnect. Inbox acknowledgement/consumption and responsibility closure must also be observable. Exact names are drafts and versioned before implementation.

## Reconnect protocol

Load an authorized snapshot and its matching cursor, then replay subsequent persisted events. Make the snapshot/stream handoff gap-free. Repeated events and message deltas are deduplicated by stable identity/sequence. A cursor outside retention triggers explicit snapshot refresh. Only events authorized for that client are streamed; keep secrets and inaccessible artifact content out of events.

Typed domain failures include runtime unavailable, permission denied, invalid transition, stale version, timeout, executor disconnected and uncertain external outcome. Normalize useful failure categories without erasing vendor evidence. Bound stream buffers and slow-client behavior; disconnecting an observer does not cancel work.

SSE is server-to-client observation. Commands and human approval decisions use authenticated request paths. Decide cookie/session strategy, CSRF/origin rules and executor transport contracts before network-enabled implementation.


## Operational observability

Observability and troubleshooting are release scope, with Effect tracing / OpenTelemetry for cross-agent execution and delegation traces. Keep that integration behind an internal observability boundary; exact SDK versions, exporter/backend, retention and any opt-in telemetry policy remain open. Correlate Quest/task/delegation/attempt/executor IDs so a stalled response or failed continuation can be explained without exposing secret-bearing prompts or credentials. Product telemetry transmission is not authorized by this documentation artifact.

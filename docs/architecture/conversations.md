# Conversations, threads and runtime sessions

**Decided.** Threads are durable discussion contexts; executions are runtime work. Each agent has multiple threads. Selecting a different thread, collapsing a panel or disconnecting the UI does not cancel tasks.

A thread stores title, owning agent, timestamps, messages, links to Quests and tool activity, and session bindings. Persist user input before dispatch and correlate streamed deltas with stable message/turn IDs. A partial response remains distinguishable from a completed response or interrupted turn.

The UI restores an agent's last selected thread and keeps relevant side-panel state. A pinned Quest may remain visible while the user discusses another topic. The server owns durable work regardless of client focus. Search titles and persisted messages with links to the correct thread.

## Session mapping

Adapters create or resume sessions using supported vendor mechanisms. Record runtime/executor/session binding and capability evidence. A resumed native session and a reconstructed context are different recovery modes; show that distinction. Never claim exact resumption when only message replay is available.

Within a session, serialize prompts if required by that runtime. Across independent supported sessions, schedule concurrent work within policy and capacity. New inbox results received while an agent is busy are persisted and coalesced for a safe continuation; do not inject concurrent prompts into a session that cannot accept them.

## Message categories

User conversation messages, assistant text, tool events, structured task results and inter-agent messages share correlation links but retain different semantics. A chat transcript is not the responsibility ledger. Questions have explicit reply obligations; progress updates normally update visibility without demanding a model turn.

## Interrupt and reconnect

Stopping a turn requests adapter interruption and records acknowledgement/outcome. It does not delete history or silently cancel every delegated child. The user must be able to distinguish stopping the current turn from canceling a task or Quest.

Reconnect from an authorized snapshot plus durable event cursor ([ADR 013](../decisions/013-event-journal.md)). Deduplicate messages/deltas, recover missed events, and display stale/unverified activity honestly. Cursor expiry or compaction requires a fresh snapshot, not silent data omission.

Thread fork/context-snapshot behavior, message retention limits, and exact search indexing remain open.

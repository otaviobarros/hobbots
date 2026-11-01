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

A reply records the stop in two steps. Stop moves a streaming reply to `stopping` and emits `TurnStopRequested`; the reply still counts as in progress, keeps any text the runtime sends, and may still complete if the turn finishes first. Once the adapter confirms the turn has ended (for Claude Code, once its process has exited, killed if it outlives a grace period), the reply becomes `stopped` with its partial text and `TurnStopped` follows. Repeated stop requests, or a stop with no turn running, change nothing. A turn Hobbots ends itself (a restart, pause or retirement) is `interrupted`, not `stopped`; on restart a reply left `stopping` becomes `stopped` and one left `streaming` becomes `interrupted`. Each event follows the reply's `MessageUpserted`.

A reply the runtime cuts off after it started writing is also `interrupted`, with `error` saying why; one cut off before any text is `failed`. A reply the provider's usage limit ends is `limited`, with `resetsAt` when the provider says the allowance refills. Continue (`POST /api/threads/:threadId/messages/:messageId/continue`) resumes an `interrupted` or `limited` reply in the same message: only the thread's latest reply, only while its hob is active and nothing else runs in the thread. The reply streams again on the thread's current brain, and the runtime is asked to continue from the end of the text it kept. A limited or cut-off reply can also continue on another brain: the thread switches first, then the reply continues in place with a briefing. Waiting for the refill is not built yet.

A thread keeps one runtime session per runtime, each with the last message it has seen, and may name its own brain (runtime, model, effort) instead of the hob's ([ADR 017](../decisions/017-switching-brains.md)). `PUT /api/threads/:threadId/brain` sets or clears it, and with `makeDefault` saves it as the hob's next configuration version instead. Switching never moves a session: a runtime new to the thread starts a fresh one, and one used before resumes its own. When a session missed replies from another brain, its turn carries a briefing the hub builds from the stored transcript, without asking any model. Each reply records the runtime and model that produced it.

Reconnect from an authorized snapshot plus durable event cursor ([ADR 013](../decisions/013-event-journal.md)). Deduplicate messages/deltas, recover missed events, and display stale/unverified activity honestly. Cursor expiry or compaction requires a fresh snapshot, not silent data omission.

Thread fork/context-snapshot behavior, message retention limits, and exact search indexing remain open.

# ADR 013 — The event journal and resuming the event stream

Status: **Accepted.** Refines the [API and events contract](../architecture/api-events.md) and the journal in [persistence](../architecture/persistence.md) for Slice 6.

## Context

The server publishes events to an in-process `PubSub` after each write commits, and `GET /api/events` streams them over SSE with no ID. Nothing is stored, so a client that reconnects refetches every query, and an event published while a client is away, or lost to a crash between commit and publish, is gone. Reply text streams as `MessageDelta` chunks that are held only in memory until the reply ends, so a crash mid-reply also loses the partial text.

The open question was whether to journal every text chunk with its offset, or to rebuild the reply from the saved message on resume.

## Decision

### What is journaled

- **Every state event is journaled**: `AgentUpserted`, `ThreadUpserted`, `MessageUpserted`, and the lifecycle events Slice 6 adds (`TurnStopRequested`, `TurnStopped`, `MessageQueued`, `MessageDequeued`).
- **The journal row is written in the same transaction as the change it describes.** The repository takes the events with the state change and appends them before commit, so the journal is also the outbox: a crash after commit cannot lose an event. When one change produces several events, they are appended in the order clients must apply them, for example `MessageUpserted` before `TurnStopped`.
- **Reply text is not journaled chunk by chunk.** `MessageDelta` is the one transient event: it has no sequence and no cursor. On resume the partial text is rebuilt from the message instead:
  - While a reply streams, the server checkpoints its text to the message row at most once a second, and always when it ends. The checkpoint updates the row only and journals nothing.
  - Each `MessageDelta` gains an `offset`, the position in the message's text (in UTF-16 code units, JavaScript string length) where the chunk starts. Applying a chunk is then idempotent: a client skips text it already has and refetches the thread's messages if a chunk starts past the end of its text.
  - On every connection, after replay, the server sends a progress frame for each reply still streaming: a `MessageDelta` at offset 0 carrying the full text held in memory. A reconnecting client is then exactly up to date even when the checkpoint lags.
  - After a crash, boot recovery marks a stale streaming reply interrupted (and a stale stopping one stopped) through the same journaled write, keeping the checkpointed text.

**Write cost.** Journaling chunks would write one row per chunk: Claude Code streams tens of chunks a second, so a long reply adds hundreds to a few thousand single-row transactions, the same text stored twice (chunks and final message), and resumes that replay hundreds of tiny frames. Rebuilding costs at most one `UPDATE` a second per streaming reply plus one journal row per state change, and resume sends one frame per streaming reply. Its limit is that up to a second of text can be lost in a crash, which is acceptable because that reply is shown as interrupted anyway.

### The envelope

Every journaled event is stored and sent in one envelope:

| Field | Meaning |
| --- | --- |
| `id` | Event ID (UUID). Stable identity, for logs and causation. |
| `sequence` | Integer, unique and gap-free per installation, in commit order. The cursor. |
| `schemaVersion` | Integer per event type, starting at 1. |
| `type` | The payload's `_tag`, stored as a column for filtering and compaction. |
| `occurredAt` | ISO-8601 time of the commit. Display only; order comes from `sequence`. |
| `correlation` | The IDs that apply: `agentId`, `threadId`, `messageId`, and later `questId`, `taskId`, `delegationId`, `attemptId`, `executorId`, `runtimeSessionId`. Used for authorization filtering and tracing. |
| `causationId` | The event ID that caused this one, or null. |
| `payload` | A variant of the `HobbotsEvent` union in `@hobbots/domain`. Secrets are redacted before it is written. |

New event types are added as variants of `HobbotsEvent` with a past-tense name (`TurnStopped`, `MessageQueued`). A payload carries the IDs it affects, or the whole entity for an `…Upserted` event. A new event is journaled unless it is a high-rate progress signal whose content is already in durable state, and a transient event needs an idempotent form like the delta's offset.

An incompatible payload change bumps that type's `schemaVersion`. The server decodes every version still in retention (upcasting old ones), or the migration rotates the journal epoch, which expires every cursor. A client that meets an unknown type or a newer version than it knows resyncs instead of guessing, so a browser tab left open across an upgrade recovers by itself.

### Sequence and cursor

- The sequence comes from a single counter row incremented inside the writing transaction (`UPDATE … SET sequence = sequence + 1 RETURNING sequence`). This is portable SQL, gap-free, and matches commit order on both SQLite and PostgreSQL; an identity or autoincrement column is not, because on PostgreSQL concurrent transactions can commit out of order and roll back with gaps.
- The cursor is opaque to clients: `<epoch>.<sequence>`, where the epoch is a random ID created with the journal. A restored backup or a reset database gets a new epoch, so a cursor from before it is never mistaken for a position in the new one.
- The in-process bus publishes journal entries only after commit, and is a wake-up signal, not the source of order. Each SSE connection sends journal entries strictly by sequence: when the next entry from the bus is ahead of what it has sent, it reads the missing range from the journal first.

### Resume over SSE

- Each journaled event goes out as an SSE frame with `id: <cursor>` and the envelope as JSON data. Transient frames carry no `id`, which leaves the browser's last event ID unchanged. The server sets `retry` to one second and sends a keep-alive comment every 15 seconds.
- The browser's `EventSource` sends `Last-Event-ID` on reconnect, and the server resumes after that cursor. A client that cannot set the header on its first connection may pass `?after=<cursor>`; the header wins when both are present.
- The first frame of every connection is `Ready` with `{ cursor, resumed }`, sent with `id` set to that cursor:
  - **Resumed** (the cursor is from this epoch and still in retention): the server subscribes to the bus, sends `Ready`, replays every entry after the cursor, sends the progress frames, then continues live without a gap.
  - **Fresh** (no cursor, an unknown epoch, or a cursor older than retention): `Ready` carries `resumed: false` and the current head. The client refetches its queries, which are the snapshot. The stream is already live, so nothing committed after the head is missed; an entry applied before the refetch lands is harmless, because upserts carry whole entities and later entries arrive in order.
- No separate snapshot endpoint is needed: the existing queries loaded after a fresh `Ready` are the snapshot, and the `Ready` cursor is the one that matches them.
- A connection whose client falls behind has a bounded buffer (1,000 frames). When it overflows, the server closes the connection and the client resumes from its cursor, so a slow client costs a replay, not memory. Disconnecting an observer never cancels work.
- Every connection is authorized for the events it receives; today every allowed device sees the whole installation, and the correlation IDs are where narrower filtering will apply.

### Retention and compaction

- The journal keeps entries for **7 days** and always keeps the **latest 10,000**, whichever retains more. Compaction deletes older entries at startup and then hourly.
- The journal serves client resume only. Current state lives in its own tables, and durable work (inbox deliveries, responsibilities, attempts) keeps its own records, so compaction never removes something work depends on.
- A cursor older than the oldest retained entry is answered with a fresh `Ready`, never with a partial replay.

## Rationale

Journaling in the same transaction is the smallest change that makes events survive a crash on a single-writer SQLite hub, and it stays correct on PostgreSQL. Rebuilding streamed text from the message keeps the journal small and resume cheap, at the cost of at most a second of text in a crash. Using the existing queries as the snapshot and the first `Ready` frame as its cursor avoids a second read model, and the epoch and explicit expiry turn every case the journal cannot replay into a visible refetch rather than silent loss.

## Consequences for Slice 6

- **#112 Durable event journal:** journal and counter tables (with an epoch) in a new migration; repositories append events in the writing transaction; the bus publishes committed entries; message text checkpoints while streaming; boot recovery journals its writes; retention and compaction.
- **#113 Resume the event stream:** SSE `id`, `Last-Event-ID` and `?after=`, the `Ready` frame, ordered replay with gap filling, progress frames, the bounded buffer; the web client resumes instead of refetching, refetches on a fresh `Ready`, and applies deltas by offset.
- **#114 Stop:** `TurnStopRequested` and `TurnStopped` are journaled in the transaction that writes the matching `MessageUpserted`, after it.
- **#115 Queue:** `MessageQueued` and `MessageDequeued` are journaled in the transaction that writes the queued row or its start or removal.
- **#116 Chat states:** "Reconnecting" is the time between losing the stream and the next `Ready`; an interrupted reply shows its checkpointed text.
- **#117 Search:** emits no events. Index updates belong in the transaction that writes the message, not in a journal consumer.
- **#118 End to end:** prove a crash between commit and publish, a minute offline, a reconnect mid-reply and an expired cursor.

# Persistence, journal and durable work

**Decided:** one SQLite database per installation, PostgreSQL-compatible SQL tested on both, PostgreSQL optional for a later server edition ([ADR 011](../decisions/011-sqlite-storage.md)), SQL-backed durable records with Effect integration, and Effect's built-in SQL migrator. The transaction/outbox/lease design below is a draft; the physical schema evolves through migrations.

Persist agents/configuration versions, threads/messages/session bindings, Quests/tasks/dependencies/delegations, attempts, inbox/delivery/processing state, responsibilities, approvals/policy versions, executor identity/health, artifact metadata and event sequences. Store large artifacts outside relational rows with authorized stable references as appropriate; exact remote object storage is not locked.

Use validated current-state projections plus an append-only event journal ([ADR 013](../decisions/013-event-journal.md)). This does not require full event sourcing for every entity. Each state change appends its events to the journal in the same transaction, with a gap-free sequence from a counter row, so the journal is also the outbox for clients. Notify in-process subscribers and SSE clients after commit; the journal, not the bus, defines order.

Use unique idempotency keys for commands and message/effect handling. Enforce expected versions for competing transitions. Claims have owner, expiry and fencing/version semantics. Reclaim abandoned work without allowing an older worker to overwrite a newer result. Ordering is per documented durable stream/aggregate; do not infer global causality from timestamps alone.

Runtime tool side effects are not inside a SQL transaction. Record intent and reconcile actual outcome using provider idempotency where available. Unknown outcomes need explicit state; automatic replay is restricted to safely retryable operations.

Back up relational state and artifact storage consistently. Define migration, retention, redaction and restore policy before release. Each installation has one database; there are no replicas to synchronize. Test duplicate handling, crash boundaries, leases, migrations and restore against SQLite, and against PostgreSQL before offering it.

The journal keeps 7 days and at least the latest 10,000 entries; an older cursor gets an explicit snapshot refresh. It serves client resume only: durable work keeps its own records, so compaction never discards what open responsibilities need. Exclude secrets from payloads ([redaction](permissions.md#secrets-in-tool-activity)) and restrict artifact access through executor/workspace policy. A tool step's full log is a file in the data folder's `tool-logs` folder, which no hob can reach, named by a digest of its thread, reply and step ids. The hub writes it already redacted, owner-only, without following links, and reads it back only for a step that says it was logged, and only when it is a regular file with one name that the hub's own user owns, so a planted link or file is never served.

## Search

Thread titles and settled messages are searchable (CH-006). Migration `0011_search_index` adds the index: FTS5 tables with triggers on SQLite, GIN expression indexes on PostgreSQL ([ADR 011](../decisions/011-sqlite-storage.md)). The index changes in the same write as the thread or message, a message joins it once it settles (a queued message once its turn starts, a reply once it stops streaming or stopping), and the migration indexes what was already stored. Threads of retired hobs are left out. `GET /api/search?q=` returns one hit per thread, most recently active first, with its newest matching messages as snippets; it emits no events.

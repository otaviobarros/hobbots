# Persistence, journal and durable work

**Decided:** one SQLite database per installation, PostgreSQL-compatible SQL tested on both, PostgreSQL optional for a later server edition ([ADR 011](../decisions/011-sqlite-storage.md)), SQL-backed durable records with Effect integration, and Effect's built-in SQL migrator. The transaction/outbox/lease design below is a draft; the physical schema evolves through migrations.

Persist agents/configuration versions, threads/messages/session bindings, Quests/tasks/dependencies/delegations, attempts, inbox/delivery/processing state, responsibilities, approvals/policy versions, executor identity/health, artifact metadata and event sequences. Store large artifacts outside relational rows with authorized stable references as appropriate; exact remote object storage is not locked.

Use validated current-state projections plus an append-only event journal. This does not require full event sourcing for every entity. Update authoritative state, event and outgoing obligations in one transaction where consistency demands it. Notify in-process subscribers and SSE clients after commit. An outbox or equivalent durable mechanism repairs a crash between commit and dispatch.

Use unique idempotency keys for commands and message/effect handling. Enforce expected versions for competing transitions. Claims have owner, expiry and fencing/version semantics. Reclaim abandoned work without allowing an older worker to overwrite a newer result. Ordering is per documented durable stream/aggregate; do not infer global causality from timestamps alone.

Runtime tool side effects are not inside a SQL transaction. Record intent and reconcile actual outcome using provider idempotency where available. Unknown outcomes need explicit state; automatic replay is restricted to safely retryable operations.

Back up relational state and artifact storage consistently. Define migration, retention, redaction and restore policy before release. Each installation has one database; there are no replicas to synchronize. Test duplicate handling, crash boundaries, leases, migrations and restore against SQLite, and against PostgreSQL before offering it.

Storage must not silently discard events needed for live cursors or open responsibilities. Define cursor expiry and snapshot rebuild before journal compaction. Exclude secrets from payloads and restrict artifact access through executor/workspace policy.

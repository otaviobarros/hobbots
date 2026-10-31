# Data standards

Rules for durable state and SQL. Read the [persistence contract](../architecture/persistence.md) before you change storage.

### STD-DATA-001 Coordination state is durable

Store messages, responsibilities, results, execution attempts, waits and recovery state in the database. Fibers, queues, PubSub and schedules are in-process tools. They never hold state that must survive a restart.

- **Why:** the hub restarts, and hobs must resume their work without loss. See [ADR 004](../decisions/004-durable-inbox.md) and [ADR 007](../decisions/007-durability-and-storage.md).
- **Enforced by:** restart-recovery tests (STD-TEST-002) and review.
- **Applies to:** `apps/server`, `packages/*`.

### STD-DATA-002 SQL stays PostgreSQL-compatible

Every installation runs on SQLite, and every query and migration also runs on PostgreSQL. Write SQL that both engines accept. Run `pnpm test:pg` when you change SQL, migrations or repositories.

- **Why:** self-hosted hubs need a PostgreSQL path without a rewrite. See [ADR 011](../decisions/011-sqlite-storage.md).
- **Enforced by:** the PostgreSQL CI job and `pnpm test:pg`.
- **Applies to:** `packages/persistence`.

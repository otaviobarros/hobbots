# ADR 011 — SQLite for every installation

Status: **Accepted.** Supersedes the storage choice of [ADR 007](007-durability-and-storage.md) ("SQLite locally and PostgreSQL remotely"); its durability and recovery decisions stand.

## Decision

- Each installation has one SQLite database (`node:sqlite` through `@effect/sql-sqlite-node`), written by the single server process in the hub's data folder.
- All data access goes through Effect's generic `SqlClient` and the Effect migrator. SQL stays PostgreSQL-compatible; where the dialects differ, the query chooses explicitly.
- Tests can run the persistence and server suites against SQLite or PostgreSQL (`HOBBOTS_TEST_DB`), and CI runs both.
- PostgreSQL remains an optional backend for a later server edition with several workers or high availability. Desktop installations never need it.
- Long-running reads such as search run off the event loop, in a worker thread.

## Rationale

The [hub model](010-desktop-hub.md) has one server writing one database, which SQLite handles well with no extra process, install size or upgrade chores. A spike ran the existing migrations and repository queries unchanged on PostgreSQL. Keeping the SQL portable keeps that option cheap. An in-process WebAssembly PostgreSQL used too much memory for a background service.

## Consequences

Backups use the SQLite online backup API plus the artifact folder. Moving data between installations is an export and import, not replication.

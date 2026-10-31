# ADR 011 — SQLite for every installation

Status: **Accepted.** Supersedes the storage choice of [ADR 007](007-durability-and-storage.md) ("SQLite locally and PostgreSQL remotely"); its durability and recovery decisions stand.

## Decision

- Each installation has one SQLite database (`node:sqlite` through `@effect/sql-sqlite-node`), written by the single server process in the hub's data folder.
- All data access goes through Effect's generic `SqlClient` and the Effect migrator. SQL stays PostgreSQL-compatible; where the dialects differ, the query chooses explicitly.
- Tests can run the persistence and server suites against SQLite or PostgreSQL (`HOBBOTS_TEST_DB`), and CI runs both.
- PostgreSQL remains an optional backend for a later server edition with several workers or high availability. Desktop installations never need it.
- Long-running reads such as search run off the event loop, in a worker thread.
- Search over thread titles and messages uses each database's own full-text index behind one query service: SQLite FTS5 tables kept current by triggers, and GIN expression indexes on `to_tsvector('simple', …)` in PostgreSQL. Both update in the same write as the row, so search needs no events and no separate indexing job. On a SQLite file the queries run in a worker thread with its own read-only connection.

## Rationale

The [hub model](010-desktop-hub.md) has one server writing one database, which SQLite handles well with no extra process, install size or upgrade chores. A spike ran the existing migrations and repository queries unchanged on PostgreSQL. Keeping the SQL portable keeps that option cheap. An in-process WebAssembly PostgreSQL used too much memory for a background service.

## Consequences

Search matches every word of the query as a prefix. SQLite ignores accents and PostgreSQL's `simple` configuration keeps them, so "Café" finds "Café" on both but "cafe" finds it only on SQLite. A separate search engine was not needed at hub scale.

Backups use the SQLite online backup API plus the artifact folder. Moving data between installations is an export and import, not replication.

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- Every migration applies in order on an empty SQLite database and on PostgreSQL: `[TC-DP-003]`, run on both in CI.
- Search finds a thread by a word from an old message, from a worker thread on SQLite: `[TC-CH-060]`, `[TC-CH-063]`, `[TC-CH-065]`.
- An online backup restores the hub to the backed-up state. Not proven yet: [#16](https://github.com/otaviobarros/hobbots/issues/16).

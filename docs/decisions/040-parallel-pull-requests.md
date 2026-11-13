# ADR 040 — Migrations and CI for many pull requests at once

Status: **Accepted.** Amends [ADR 011](011-sqlite-storage.md) (migrations run through Hobbots' own migrator instead of Effect's) and the CI of [ADR 009](009-toolchain-and-validation-slice.md) (a pull request runs the slower suites only when it reaches them).

## Context

Many pull requests are open at once, most of them written by agents in parallel. Two things slowed every one of them down.

**Migrations conflicted by design.** A migration was named by the next free number, such as `0115_thread_members.ts`, and listed by hand in `migrations/index.ts`. A test required the numbers to be sequential, and another named the highest one. Two pull requests written at the same time took the same number, and every pull request that added a migration edited the same last lines of the index and the same line of the backup test. Whichever merged second had to rename its file, its key, its test cuts and the expected version, and run CI again. Even two different numbers conflicted in the index.

Effect's migrator could not simply take ids that are not in merge order: it runs only ids above the highest one a database has applied. A migration that merges after one with a higher id would be skipped on every database that already has the higher one, silently.

**CI ran everything on every push.** One run of a pull request was 16 jobs: the SQLite checks (3 jobs), the PostgreSQL suites (2), eight browser shards, the burn-in and two summary jobs. The account runs about 20 jobs at once, so a second pull request's run mostly waited in the queue. A pull request that only changed orchestration still ran all eight browser shards and both PostgreSQL shards, and every merge of `main` into a branch, to resolve the conflicts above, ran them all again.

## Decision

### Migrations

- A new migration is named by the UTC minute it was made: `202611132315_thread_members.ts` (`YYYYMMDDHHMM`). `pnpm migration:new <name>` writes it, and moves to the next free minute if one is taken. The 114 migrations `0001` to `0114` keep their names and ids.
- No list names the migrations. `migrations/index.ts` reads the folder: Vite and Vitest list it when they build the module (`import.meta.glob`), and tsx, which has no bundler, reads it with `readdirSync` and loads each file with `require`. The record is sorted by id.
- Hobbots has its own migrator (`packages/persistence/src/migrator.ts`). It runs every migration a database has not applied, in id order, in one transaction, and records each one. On PostgreSQL it locks the table first, as Effect's did. It keeps Effect's table, `effect_sql_migrations`, and its rows, so every existing database carries on. PostgreSQL's `migration_id` was an `integer`, too small for a minute's id, so the migrator widens it to `bigint` once. SQLite's `INTEGER` already holds 64 bits.
- Two migrations with one id are refused before anything runs. A failed migration rolls back the whole run.
- A migration still never changes once it merges.
- The schema version stays the highest applied id. A database can now lack a migration below its highest, so the backup before an update (ADR 026) is made whenever any known migration is missing, not only when the highest is higher.

### CI

- The SQLite checks, which the `main` ruleset requires, run on every push to a pull request.
- A pull request runs the PostgreSQL suites only when it changes the persistence package or what every package builds from (dependencies, the toolchain, the CI workflow), and the browser tests only when it changes the web app, the UI or art packages, the API or the domain, or what every package builds from. `scripts/ci-changes.mjs` decides, and the required PostgreSQL check passes when its shards were skipped for that reason.
- A draft pull request runs neither, nor the burn-in. Marking it ready for review runs them.
- A push to `main` runs everything, and so does a merge queue's group: the workflow has the `merge_group` trigger, so a merge queue works as soon as the repository turns one on.
- A newer push to a pull request still cancels its older run.

## Rationale

Naming by time is what Rails migrations and Flyway's out-of-order mode do: two branches never pick the same name, and the order on an empty database is the order the migrations were written. Applying every missing id, instead of only higher ones, is what makes that safe when branches merge in another order.

A migration that depends on another one is rare, and when it happens the dependency was written first, so it has the lower id. If a branch starts to depend on a migration merged after it was named, `[TC-DP-003]` fails on an empty database, and the fix is to rename it with `pnpm migration:new`.

Effect's migrator was kept until it no longer fit: it has no option to run ids below the highest applied one. The replacement is one small file that reuses Effect's `SqlClient`, its transactions and its table.

Skipping suites by path keeps the queue short for the common pull request, while `main` and a future merge queue still run everything before release. Browser tests are not a required check, so skipping them on a pull request changes nothing about what may merge; a regression they would have caught shows on `main`'s run, and in the merge queue's once there is one.

## Consequences

- Open pull requests that add a migration rename it once to a minute id (see `CONTRIBUTING.md`), and stop editing `migrations/index.ts` and the expected version in `backup.test.ts`.
- On an existing database, a migration from a branch that merged late runs after ones with higher ids. Migrations must not assume that every lower id ran before them unless they were written after it.
- A pull request that changes server behavior the browser tests cover, without touching the web client, finds out from `main`'s run instead of its own. The burn-in still runs every browser test the pull request changes.
- Tests that run an older subset of migrations and seed through the current repository still list the later migrations they need. That list is the remaining shared spot.

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- Every migration is named `0001` to `0114` or by a valid UTC minute, and sorted by id: `[TC-DP-040-01]`.
- A migration whose id is below one already applied still runs, once: `[TC-DP-040-02]`, on SQLite and PostgreSQL.
- A database Effect's migrator made keeps what it applied and gets only the missing migrations, with PostgreSQL's id column widened to `bigint`: `[TC-DP-040-03]`, on SQLite and PostgreSQL.
- Two migrations with one id are refused, and a failed run applies nothing: `[TC-DP-040-04]`.
- Every migration applies in order on an empty database: `[TC-DP-003]`, on both databases.
- The new migration script names files by minute and avoids a taken minute, and CI picks the suites a change reaches: `scripts/new-migration.test.mjs` and `scripts/ci-changes.test.mjs`.

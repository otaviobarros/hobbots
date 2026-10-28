# packages/persistence

Validation slice implemented ([ADR 009](../../docs/decisions/009-toolchain-and-validation-slice.md)): SQLite client, migrations and the repository for agents, threads and messages.

SQLite/PostgreSQL repositories, transactions, journal, outbox and migrations.

`SqliteLive(filename)` is the database every installation uses. `PgLive(url)` runs the same migrations and repositories on PostgreSQL, so the SQL stays portable ([ADR 011](../../docs/decisions/011-sqlite-storage.md)).

## Test database

Tests take their database from `TestDatabase` in `@hobbots/persistence/testing`. Each build of the layer is a fresh, isolated database with every migration applied.

| `HOBBOTS_TEST_DB`  | Database                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `sqlite` (default) | In-memory SQLite                                                                                |
| `postgres`         | A new schema in the database at `HOBBOTS_TEST_DATABASE_URL`, dropped when the layer is released |

The persistence and server suites use it, so both run on either database. Where the dialects differ, the query chooses explicitly: ties sort by `id` byte by byte (`COLLATE "C"` on PostgreSQL), and migration `0003_look_seed_bigint` widens the look seed on PostgreSQL only. The tie-order test detects a missing `COLLATE "C"` only on a PostgreSQL database whose default collation is not C, such as the official image's `en_US.utf8`.

```sh
HOBBOTS_TEST_DB=postgres HOBBOTS_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres pnpm test
```

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Credentials are never stored here.

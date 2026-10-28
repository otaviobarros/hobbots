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

CI runs the persistence and server suites both ways. A new variable that changes test behavior must be declared on the `test` task in [`turbo.json`](../../turbo.json); Turborepo drops undeclared variables.

```sh
HOBBOTS_TEST_DB=postgres HOBBOTS_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres pnpm test
```

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Credentials are never stored here.

# infrastructure/local

Local development services. Future local server lifecycle and installation guidance belongs here too; no launch service is installed.

## Test PostgreSQL

[`compose.yaml`](compose.yaml) runs PostgreSQL 18 for the persistence and server test suites ([ADR 011](../../docs/decisions/011-sqlite-storage.md)). Desktop installations never need it.

| Setting  | Value                                               |
| -------- | --------------------------------------------------- |
| Address  | `127.0.0.1:54329`, reachable only from this machine |
| Database | `hobbots_test`, user `postgres`, no password        |
| Data     | In memory; discarded when the container stops       |

From the repository root, with Docker running:

```sh
pnpm test:pg   # starts the database if needed and runs the suites against it
pnpm pg:down   # stops it and discards its data
```

`pnpm pg:up` only starts it. Each build of the test database creates its own schema and drops it afterwards, so runs never see each other's rows. Every checkout and worktree shares this one container, so `pnpm pg:down` stops the database for all of them, and starting it from a checkout with a different `compose.yaml` replaces it.

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. No application source or runtime credentials are included here.

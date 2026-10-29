# Hobbots

A personal, local-first, self-hostable workspace for AI agents ("hobs") that execute, delegate, communicate and close the loop on their own, within boundaries you trust. Learn more at [hobbots.ai](https://hobbots.ai).

Hobbots does not build a new model or agent engine. It hosts existing runtimes such as Claude Code, Codex and ACP-compatible agents, and adds what they lack together: persistent identities and threads, durable delegation and inboxes, enforceable permissions and one view of all the work.

## Status

**Early validation build.** The code is a first slice ([ADR 009](docs/decisions/009-toolchain-and-validation-slice.md)): one hob on Claude Code, persistent threads and streaming chat, in the browser and in an Electron app. Delegation, inboxes, Quests, permissions and other providers are MVP work that is not built yet.

## Run it

Requirements: Node.js 22.12 or later, pnpm, and [Claude Code](https://code.claude.com/docs/en/setup) 2.1.301 or later, installed and signed in. Hobbots runs the host's `claude`; it does not ship its own.

```sh
pnpm install
pnpm dev:desktop   # Electron app with the local server
pnpm dev           # server and web client, open http://localhost:5173
pnpm check         # Biome, typecheck and tests
pnpm package:mac   # unsigned Hobbots.app for this Mac in apps/desktop/release
```

Set `HOBBOTS_RUNTIME=fake` to run the server with a deterministic fake runtime instead of Claude Code.

The tests use in-memory SQLite. To run the persistence and server suites on PostgreSQL as well, start Docker and run:

```sh
pnpm test:pg       # starts PostgreSQL on 127.0.0.1:54329 if needed, then runs the suites
pnpm pg:down       # stops it and discards its data
```

## Repository

- `apps/`: `server` (Effect TS v4 HTTP API and SSE), `web` (React client), `desktop` (Electron).
- `packages/`: `domain`, `api`, `persistence`, `runtimes` and `ui` are implemented; the other packages are planned boundaries.
- `docs/product/`: vision, MVP requirements and open questions.
- `docs/architecture/`: contracts for conversations, inbox, orchestration, lifecycle, permissions, runtime adapters, persistence, API and deployment.
- `docs/decisions/`: architecture decision records.
- `docs/design/`: the design specification and the screen inventory.

Contributors start with [CONTRIBUTING.md](CONTRIBUTING.md); coding agents with [AGENTS.md](AGENTS.md).

## License

Hobbots is licensed under the [Apache License 2.0](LICENSE).

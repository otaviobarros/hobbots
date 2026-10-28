# Hobbots

A personal, local-first, self-hostable workspace for AI agents ("hobs") that execute, delegate, communicate and close the loop on their own, within boundaries you trust. Learn more at [hobbots.ai](https://hobbots.ai).

Hobbots does not build a new model or agent engine. It hosts existing runtimes such as Claude Code, Codex and ACP-compatible agents, and adds what they lack together: persistent identities and threads, durable delegation and inboxes, enforceable permissions and one view of all the work.

## Status

**Early validation build.** The code is a first slice ([ADR 009](docs/decisions/009-toolchain-and-validation-slice.md)): one hob on Claude Code, persistent threads and streaming chat, in the browser and in an Electron app. Delegation, inboxes, Quests, permissions and other providers are MVP work that is not built yet.

## Run it

Requirements: Node.js 22.12 or later, pnpm, and a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) login.

```sh
pnpm install
pnpm dev:desktop   # Electron app with the local server
pnpm dev           # server and web client, open http://localhost:5173
pnpm check         # Biome, typecheck and tests
```

Set `HOBBOTS_RUNTIME=fake` to run the server with a deterministic fake runtime instead of Claude Code.

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

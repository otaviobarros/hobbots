# Hobbots

A personal, local-first, self-hostable workspace for AI agents ("hobs") that execute, delegate, communicate and close the loop on their own, within boundaries you trust. Learn more at [hobbots.ai](https://hobbots.ai).

Hobbots does not build a new model or agent engine. It hosts existing runtimes such as Claude Code, Codex and ACP-compatible agents, and adds what they lack together: persistent identities and threads, durable delegation and inboxes, enforceable permissions and one view of all the work.

## Status

**Early validation build.** The code is a first slice ([ADR 009](docs/decisions/009-toolchain-and-validation-slice.md)): one hob on Claude Code, persistent threads and streaming chat, in the browser and in an Electron app. Delegation, inboxes, Quests, permissions and other providers are MVP work that is not built yet.

## Install the Mac app

Requirements: macOS 13 Ventura or later, on Apple silicon or Intel, and [Claude Code](https://code.claude.com/docs/en/setup) 2.1.301 or later, installed and signed in. The app runs the Claude Code installed on your Mac; it does not ship its own. Workshop tells you when Claude Code is missing, outdated or signed out.

1. Download the `.dmg` for your Mac from the [latest release](https://github.com/otaviobarros/hobbots/releases/latest): `arm64` for Apple silicon, `x64` for Intel. Apple menu › About This Mac shows which one you have.
2. Open the `.dmg` and drag Hobbots onto the Applications shortcut beside it, then eject the disk image.
3. Open Hobbots from Applications. The app is not signed by an Apple developer yet, so macOS blocks the first launch: choose **Done** in the dialog.
4. Open System Settings › Privacy & Security, scroll to Security, choose **Open Anyway** next to the message about Hobbots, confirm with your password or Touch ID, then choose **Open**. macOS remembers this, so later launches open normally.

Hobbots keeps its data, including every thread, in `~/Library/Application Support/Hobbots`, outside the app.

**Update:** quit Hobbots, download the new `.dmg` and drag the app onto Applications again, replacing the old copy. Your data stays where it is. A new version may need Open Anyway once more.

**Remove:** quit Hobbots and drag it from Applications to the Trash. To delete your data as well, remove `~/Library/Application Support/Hobbots` (in Finder, Go › Go to Folder).

## Run from source

Requirements: Node.js 22.12 or later, pnpm, and [Claude Code](https://code.claude.com/docs/en/setup) 2.1.301 or later, installed and signed in. Hobbots runs the host's `claude`; it does not ship its own.

```sh
pnpm install
pnpm dev:desktop   # Electron app with the local server
pnpm dev           # server and web client, open http://localhost:5173
pnpm check         # Biome, typecheck and tests
pnpm package:mac   # unsigned .dmg installers for Apple silicon and Intel in apps/desktop/release
```

Set `HOBBOTS_RUNTIME=fake` to run the server with a deterministic fake runtime instead of Claude Code.

The tests use in-memory SQLite. To run the persistence and server suites on PostgreSQL as well, start Docker and run:

```sh
pnpm test:pg       # starts PostgreSQL on 127.0.0.1:54329 if needed, then runs the suites
pnpm pg:down       # stops it and discards its data
```

The first-launch flow (Welcome, setup, first hob, Home, and a restart) runs in Chromium against a hub with the fake runtime and an empty data folder under `.data/e2e`. Install the browser once, then run it:

```sh
pnpm --filter @hobbots/web exec playwright install chromium
pnpm test:e2e      # builds the web client, then runs apps/web/e2e (HOBBOTS_E2E_PORT, default 4380)
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

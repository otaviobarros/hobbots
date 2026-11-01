<p align="center">
  <img src="docs/assets/readme-banner.svg" width="100%" alt="The word HOBBOTS in pixel letters over a village at night: two houses with lit windows, the chief of the hobs with a lantern staff, and three hobs.">
</p>

<h1 align="center">Hobbots</h1>

<p align="center"><strong>Little helpers that do your chores while you sleep.</strong></p>

<p align="center">
  <a href="https://hobbots.app">hobbots.app</a> ·
  <a href="#install-the-mac-app">Install</a> ·
  <a href="#run-from-source">Run from source</a> ·
  <a href="docs/STATUS.md">Status</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

Hobbots is a personal, local-first, self-hostable workspace for AI agents. Each agent is a **hob**: a small helper with a name, a face and its own threads. Today your hobs chat, use tools in the folders you give them, and keep working after you close the window. Hobbots is being built so they can also delegate to each other, report back and close the loop on their own, within boundaries you trust.

Hobbots does not build a new model or agent engine. It hosts existing runtimes such as Claude Code, Codex and ACP-compatible agents, and adds what they lack together: persistent identities and threads, durable delegation and inboxes, enforceable permissions and one view of all the work.

## A field guide to the village

- **Hob:** one agent, with its own name, look, instructions, model and permissions. Every hob is a 14 × 14 pixel sprite drawn from a seed, so it looks the same everywhere.
- **The chief:** the Hobbots mark, an elder hob in a gem crown with a lantern staff. While any hob works, the lantern burns brighter.
- **Thread:** a conversation with one hob that survives restarts. Each reply shows the tools the hob used as steps.
- **Folders and the sandbox:** where a hob may work, and the OS sandbox that holds it there. Each rule is Allow, Ask or Never; answering an Ask from the app is not built yet.
- **Hub:** the one computer that runs the hobs, their threads and every runtime. Hobs act only on the hub.
- **Quest:** a goal that spans several hobs and threads, with who asked whom and what is still owed. _Not built yet._
- **Inbox:** where hobs leave questions, approvals and results for you and for each other. _Not built yet._
- **Charm:** a connection that gives a hob new abilities, such as GitHub with Push. _Not built yet._

The [glossary](docs/product/glossary.md) has the full list.

## Status

**Early build.** Hobbots runs in the browser and as a Mac app: several hobs on Claude Code, persistent threads with streaming chat, and tools within the folders you choose. Delegation, inboxes, Quests, approvals and other runtimes are MVP work that is not built yet.

The [status page](docs/STATUS.md) lists what has been proven end to end, on which setup, and what is not proven yet.

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

Requirements: Node.js 26.13 (the current LTS) or later, pnpm, and [Claude Code](https://code.claude.com/docs/en/setup) 2.1.301 or later, installed and signed in. Hobbots runs the host's `claude`; it does not ship its own.

```sh
pnpm install
pnpm dev:desktop   # Electron app with the local server
pnpm dev           # server and web client, open http://localhost:5173
pnpm check         # Biome, typecheck and tests
pnpm package:mac   # unsigned .dmg installers for Apple silicon and Intel in apps/desktop/release
```

Set `HOBBOTS_RUNTIME=fake` to run the server with a deterministic fake runtime instead of Claude Code.

The server logs writes and failures. Set `HOBBOTS_LOG_LEVEL=Debug` to log every request, reads included, or pick another of Effect's levels (`All`, `Trace`, `Debug`, `Info`, `Warn`, `Error`, `Fatal`, `None`). The default is `Info`.

The tests use in-memory SQLite. To run the persistence and server suites on PostgreSQL as well, start Docker and run:

```sh
pnpm test:pg       # starts PostgreSQL on 127.0.0.1:54329 if needed, then runs the suites
pnpm pg:down       # stops it and discards its data
```

The first-launch flow (Welcome, setup, first hob, Home, and a restart) runs in Chromium against a hub with the fake runtime and an empty data folder under `.data/e2e`. Install the browser once, then run it:

```sh
pnpm --filter @hobbots/web exec playwright install chromium
pnpm test:e2e      # builds the web client, then runs apps/web/e2e in parallel, one port per worker from HOBBOTS_E2E_PORT (default 4380)
```

## Repository

- `apps/`: `server` (Effect TS v4 HTTP API and SSE), `web` (React client), `desktop` (Electron), `site` (the hobbots.app website, Astro on Cloudflare Workers).
- `packages/`: `domain`, `api`, `persistence`, `runtimes`, `ui` and `art` are implemented; the other packages are planned boundaries.
- `docs/product/`: vision, MVP requirements and open questions.
- `docs/architecture/`: contracts for conversations, inbox, orchestration, lifecycle, permissions, runtime adapters, persistence, API and deployment.
- `docs/decisions/`: architecture decision records.
- `docs/design/`: the design specification and the screen inventory.
- `docs/assets/`: the banner above, drawn from the app's own pixel art by `node scripts/readme-banner.mjs`.

Contributors start with [CONTRIBUTING.md](CONTRIBUTING.md); coding agents with [AGENTS.md](AGENTS.md).

## License

Hobbots is licensed under the [Apache License 2.0](LICENSE).

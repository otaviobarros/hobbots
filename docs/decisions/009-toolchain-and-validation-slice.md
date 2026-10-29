# ADR 009 — Toolchain and first validation slice

Status: **Accepted.** Resolves the toolchain rows of [open questions](../product/open-questions.md) for this slice.

## Decision

- **Name:** the product is **Hobbots** (hobbots.ai). Code, package scope (`@hobbots/*`), environment variables (`HOBBOTS_*`), data folder and UI use it.
- **Monorepo:** pnpm workspaces orchestrated by Turborepo. Internal packages export TypeScript source directly; only apps build.
- **Versions:** every dependency is installed from the registry at its latest stable release (`pnpm add <pkg>`), never a hand-typed version; release candidates are acceptable, alpha/beta/nightly are not. pnpm's default minimum release age (one day) is kept, so a release published within the last 24 hours is picked up on the next install. The lockfile is the record.
- **Docs first:** library work starts from Context7 documentation, then official docs or the installed package's own docs.
- **Tooling:** TypeScript (latest), Biome for lint and format, Vitest for tests.
- **Web:** React + Vite, Tailwind CSS + shadcn/ui (latest), TanStack Query for server state, TanStack Router with hash history (works under `file://` in Electron).
- **Server:** Effect v4 `HttpApi` on `@effect/platform-node`; SSE through `HttpApiSchema.StreamSse`; SQLite via `@effect/sql-sqlite-node` (`node:sqlite`) with the Effect SQL migrator: one file per migration under `packages/persistence/src/migrations`, listed in its `index.ts`, never edited after merge.
- **Client:** typed `HttpApiClient` derived from the shared `@hobbots/api` definition, called inside Query hooks; SSE events are written into the Query cache.
- **Desktop:** Electron + electron-vite. The main process connects to a server already listening on the configured port, or launches the bundled server in a `utilityProcess`. In this slice a server the app launched stops when the app quits; [ADR 010](010-desktop-hub.md) replaces that with a background service that keeps running when the window closes.
- **Packaging:** electron-builder turns the electron-vite output into `Hobbots.app` (`pnpm package:mac`: ad-hoc signed with no certificate, `dir` target, current architecture, written to `apps/desktop/release/`). electron-vite bundles the main process and the server with every dependency into `out/`, so the app ships no `node_modules` and pnpm's symlinked layout never reaches the packager. The web build is copied into the app's resources folder and the main process loads the web client from there. The app does not ship Claude Code (see Claude runtime). Electron Forge was not chosen because it collects dependencies by crawling `node_modules`, needs pnpm's `node-linker=hoisted` for the whole workspace, and its Vite plugin would replace electron-vite. Signing, notarization, installers and release automation are later work.
- **Claude runtime:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The adapter removes `ANTHROPIC_API_KEY` from the runtime environment so Claude Code uses the claude.ai login, and reports billing from the SDK's account fields. Hobbots runs the Claude Code installed on the host ([ADR 002](002-existing-runtimes.md)) rather than the SDK's bundled platform binary: the user updates it with `claude update` as usual, the app stays about 260 MB smaller, and sign-in is the user's own. The adapter looks in `HOBBOTS_CLAUDE_EXECUTABLE`, then the installers' locations (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`), then `PATH`, because an app opened from Finder gets a bare `PATH`; those folders are also added to Claude Code's own `PATH` so an npm install finds `node`. Detection covers macOS and Linux; Windows (`claude.exe`) is later work. Health runs `claude --version` first and reports `outdated` below the oldest release verified with the locked SDK version (`minimumClaudeCodeVersion`, 2.1.301), and `unavailable` with install guidance when none is found or it does not start; chat turns refuse an outdated or missing Claude Code with the same guidance; raise the floor when an SDK upgrade needs a newer CLI.

## First slice scope

One seeded agent (Aldric) on Claude Code, many threads, streaming chat persisted in SQLite, Claude session resume per thread, runtime health in Settings and the chat header (styled per [ADR 008](008-design.md)). Until permissions are enforced, the agent runs **chat-only**: no built-in tools, `disallowedTools: ["*"]`, `permissionMode: "dontAsk"`, no settings loaded from disk, and an empty working folder. Delegation, inbox, Quests, permissions, Codex/ACP and PostgreSQL stay MVP work.

## Consequences

Event delivery is in-process after commit; there is no journal cursor or replay yet, so clients refetch after reconnecting. A turn interrupted by a process exit is marked interrupted on the next start. These are accepted limits of the validation slice, not of the MVP contracts.

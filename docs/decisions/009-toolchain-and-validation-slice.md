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
- **Desktop:** Electron + electron-vite. The main process connects to a server already listening on the configured port, or launches the bundled server in a `utilityProcess`. A server the app launched stops when the app quits.
- **Claude runtime:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The adapter removes `ANTHROPIC_API_KEY` from the runtime environment so Claude Code uses the claude.ai login, and reports billing from the SDK's account fields.

## First slice scope

One seeded agent (Aldric) on Claude Code, many threads, streaming chat persisted in SQLite, Claude session resume per thread, runtime health in Settings and the chat header (styled per [ADR 008](008-design.md)). Until permissions are enforced, the agent runs **chat-only**: no built-in tools, `disallowedTools: ["*"]`, `permissionMode: "dontAsk"`, no settings loaded from disk, and an empty working folder. Delegation, inbox, Quests, permissions, Codex/ACP and PostgreSQL stay MVP work.

## Consequences

Event delivery is in-process after commit; there is no journal cursor or replay yet, so clients refetch after reconnecting. A turn interrupted by a process exit is marked interrupted on the next start. These are accepted limits of the validation slice, not of the MVP contracts.

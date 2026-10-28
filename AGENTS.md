# Hobbots — instructions for coding agents

## Current scope

The repository holds the documentation foundation plus the first validation slice described in [ADR 009](docs/decisions/009-toolchain-and-validation-slice.md): one Claude Code agent, persistent threads and streaming chat in the browser and Electron. Begin future work from the requested scope; the documents are not standing authorization to implement or publish.

Install dependencies with `pnpm add <pkg>` at the latest stable release (RC allowed, never alpha/beta/nightly) and never hand-type versions. Run `pnpm check` (Biome, typecheck, tests) before handing work back. When a change touches SQL, migrations or repositories, also run `pnpm test:pg`, which needs Docker and runs the persistence and server suites on PostgreSQL ([ADR 011](docs/decisions/011-sqlite-storage.md)).

## Required context

Before planning or implementing, read [MVP requirements](docs/product/mvp-requirements.md), [architecture overview](docs/architecture/overview.md), [ADRs](docs/decisions/README.md), and [open questions](docs/product/open-questions.md).

Read the matching contract before changing its area:

- Identity or sessions: [agent model](docs/architecture/agent-model.md) and [conversations](docs/architecture/conversations.md).
- Delegation or scheduling: [orchestration](docs/architecture/orchestration.md), [inbox](docs/architecture/inbox.md), and [execution lifecycle](docs/architecture/execution-lifecycle.md).
- Tools or authority: [permissions](docs/architecture/permissions.md) and [runtime adapters](docs/architecture/runtime-adapters.md).
- Storage or transport: [persistence](docs/architecture/persistence.md), [API and events](docs/architecture/api-events.md), and [deployment](docs/architecture/deployment.md).
- UI: [design specification](docs/design/ui-ux.md) and [screen inventory](docs/design/screens-and-flows.md) ([ADR 008](docs/decisions/008-design.md)).

## Architectural constraints

- Use Effect TS v4 for the backend and HTTP API, Effect Schema for contracts, typed errors and services/Layers, and explicit pure state transitions. Do not reintroduce XState, Hono, or Fastify.
- Integrate existing Codex, Claude Code, and ACP runtimes. Keep domain identity independent of runtime sessions and transport protocols.
- Give every agent execution, delegation, communication, and proactive coordination capabilities, within its actual policy. Orchestrator is a role, not a privileged runtime type.
- Keep messages, responsibilities, results, execution attempts, waits, and recovery durable. Fibers, queues, PubSub, and ordinary schedules are in-process mechanisms, not durable storage.
- Default to Trusted Workspace autonomy. Enforce permissions through actual runtime or environment boundaries; a prompt is not enforcement. Delegation cannot widen authority. Hobbots MCP controls exclude approval grants, credential administration, administrative deletion and computer lifecycle operations; see the permissions contract.
- Match the Hobbots design: Home landing page, chat workspace with Quest / Inbox / Workshop tabs, the night palette, Atkinson Hyperlegible Next with Pixelify Sans for headings, stepped motion that stops with Reduce motion, and no decorative left-edge accent borders. Call agents "hobs" in the UI.
- Use one hub server and durable state model for every client ([ADR 010](docs/decisions/010-desktop-hub.md)); hobs act only on the hub. Keep SQL PostgreSQL-compatible on SQLite ([ADR 011](docs/decisions/011-sqlite-storage.md)) and keep capability-aware adapters.

## Working rules

Distinguish decided requirements and contracts from open questions. Record deliberate changes with rationale and an updated ADR; never silently replace a decided choice. Follow the requested scope and resolve material contradictions explicitly.

Fetch current library documentation through Context7 before library-specific API or configuration work: resolve the library ID, then query the relevant concept and version. Pin exact compatible Effect v4 versions when dependencies are introduced; isolate unstable APIs. Verify installed runtime capabilities rather than inferring support from a protocol name.

When implementation is authorized, verify state transitions, duplicate delivery, restart recovery, permission enforcement, and proactive closure with deterministic fake adapters, then relevant real-runtime checks. Report verification limits candidly.

## Workflow

For planning, implementation, verification and review, read the [project workflow guide](docs/agent-engineering.md): where each authority lives, check catalogs, test case IDs, worktree isolation, and the [glossary](docs/product/glossary.md).

For development tasks, use the installed agent-engineering skill matching the requested outcome: `deliver-change` for full implementation, the relevant phase skill for narrower requests (routing table in the guide). Explicit task limits and this file govern. Report a missing skill; this reference is not permission to install plugins, commit, push or publish.

# Architecture standards

Hobbots uses a light clean architecture: four layers with one dependency direction, and no required folder layout inside a package. The [architecture overview](../architecture/overview.md) and the [ADRs](../decisions/README.md) explain the system these rules protect.

### STD-ARCH-001 Dependencies point inward through four layers

Code belongs to one of four layers. A layer imports only from the layers inside it.

1. **Domain**: entities, IDs, Effect Schemas and pure state transitions (`packages/domain`).
2. **Application**: use cases that run domain logic through ports.
3. **Adapters**: code that implements ports and touches the outside world (`packages/persistence`, `packages/runtimes`, HTTP handlers, the Electron main process, the web client).
4. **Composition**: code that builds the Layers and starts an app (`apps/*`).

Composition imports adapters, adapters import application code, and application code imports the domain. `packages/api` holds the HTTP contract as Schemas, so both the server and the clients may import it.

- **Why:** inner layers stay testable without I/O, and a change to an adapter never ripples into the domain.
- **Enforced by:** each package's `package.json` declares only the workspace packages its layer allows, and pnpm blocks undeclared imports. Review covers imports inside a package.
- **Applies to:** `apps/*`, `packages/*`.

### STD-ARCH-002 Domain code is pure

Domain code does no I/O and imports nothing except `effect` and other domain modules. It never imports `node:*`, SQL clients, runtime SDKs, React or another workspace package.

- **Why:** every other layer depends on the domain, so it must run anywhere and stay deterministic.
- **Enforced by:** review.
- **Applies to:** `packages/domain`.

### STD-ARCH-003 Use cases reach the outside world through ports

A use case reaches storage, runtimes, the clock or the network only through a **port**. A port is an Effect service whose interface the application layer defines, for example `ThreadRepository` or `RuntimeAdapter`. A use case never imports a concrete adapter.

- **Why:** a test swaps the port for a fake, and an adapter can change without touching the use case.
- **Enforced by:** review.
- **Applies to:** application code in feature packages and in `apps/server`.

### STD-ARCH-004 Adapters own all I/O

Only adapters run SQL, spawn processes, open sockets, call HTTP or touch the filesystem. An adapter implements a port as a Layer and holds no business rules.

- **Why:** I/O in one layer makes failures, retries and permissions visible in one place.
- **Enforced by:** review.
- **Applies to:** all code.

### STD-ARCH-005 Apps only compose and expose

`apps/*` build Layers, start the process and expose transports: HTTP handlers in `apps/server`, the main process in `apps/desktop`, routes and screens in `apps/web`. Use cases move out of `apps/*` (see STD-ARCH-006).

- **Why:** an app that holds business rules cannot share them with another client.
- **Enforced by:** review.
- **Applies to:** `apps/*`.

### STD-ARCH-006 Use cases live in their feature package

Each use case lives in the package that owns its feature, as named in that package's README. For example, hob configuration and threads belong in `packages/agents`, and delegation belongs in `packages/orchestration`. Write new use cases in their feature package. Move existing use cases out of `apps/server` when you next change them, not in one large refactor.

- **Why:** a feature package gives each concern one home and keeps `apps/server` small.
- **Enforced by:** review.
- **Applies to:** `apps/server`, `packages/*`.

### STD-ARCH-007 Split files and folders when they grow

No package needs a fixed folder layout. When a file grows too large to read in one pass, or a folder collects too many files to scan, split the file or add inner folders by feature.

- **Why:** structure follows size, so small packages stay flat and large ones stay navigable.
- **Enforced by:** review.
- **Applies to:** all code.

### STD-ARCH-008 Domain identity stays independent of runtimes and transports

Hobs, threads, messages and tasks have Hobbots IDs. A runtime session ID or a protocol message ID is adapter data that maps to a domain record. It never replaces the domain ID.

- **Why:** a hob keeps its history when its runtime, model or transport changes.
- **Enforced by:** review.
- **Applies to:** `packages/domain`, `packages/runtimes`, `packages/persistence`.

### STD-ARCH-009 Hobs run on existing runtimes through capability-aware adapters

Hobbots hosts existing runtimes (Codex, Claude Code and ACP agents) and does not build its own agent loop. Each adapter reports the capabilities the installed runtime actually has. Check an installed runtime before you rely on a capability. A protocol name alone does not prove support.

- **Why:** runtimes differ by version, and a wrong assumption fails at run time on a user's machine. See [ADR 002](../decisions/002-existing-runtimes.md).
- **Enforced by:** review.
- **Applies to:** `packages/runtimes`.

### STD-ARCH-010 Every hob has the same capabilities

Every hob can run work, delegate, communicate and coordinate on its own initiative, within its actual policy. "Orchestrator" is a role a hob plays, not a special runtime type.

- **Why:** no code path assumes a single privileged agent. See [ADR 005](../decisions/005-agent-parity.md).
- **Enforced by:** review.
- **Applies to:** `packages/agents`, `packages/orchestration`, `packages/runtimes`.

### STD-ARCH-011 One hub serves every client

One hub server and one durable state model serve the browser, Electron and every other client. Hobs act only on the hub.

- **Why:** every client sees the same state, and no client runs work of its own. See [ADR 010](../decisions/010-desktop-hub.md).
- **Enforced by:** review.
- **Applies to:** `apps/*`.

## Guidance

- Add a DTO or a mapping layer only where a boundary needs a different shape. Pass Schemas through otherwise.

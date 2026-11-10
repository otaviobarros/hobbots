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
- **Enforced by:** `scripts/check-layers.mjs` in `pnpm check` (`pnpm lint:layers`) fails when a package declares a workspace package its layer does not allow. The table in `scripts/layers.mjs` is the source of truth for each package's layer, and an exception there carries a comment with its reason. pnpm blocks imports a package does not declare. Biome `noNodejsModules` in `biome.json` keeps browser code off Node modules, with or without the `node:` prefix. `scripts/layers.test.mjs` and `scripts/import-rules.test.mjs` prove these checks. Review covers imports inside a package.
- **Applies to:** `apps/*`, `packages/*`.

### STD-ARCH-002 Domain code is pure

Domain code does no I/O and imports nothing except `effect` and other domain modules. It never imports `node:*`, SQL clients, runtime SDKs, React or another workspace package.

- **Why:** every other layer depends on the domain, so it must run anywhere and stay deterministic.
- **Enforced by:** Biome `noRestrictedImports` on `packages/domain/src` in `biome.json` allows only `effect` and relative imports, and `noNodejsModules` rejects Node modules. `scripts/layers.mjs` allows only `effect` as a runtime dependency of `@hobbots/domain`.
- **Applies to:** `packages/domain`.

### STD-ARCH-003 Use cases reach the outside world through ports

A use case reaches storage, runtimes, the clock or the network only through a **port**. A port is an Effect service whose interface the application layer defines, for example `ThreadRepository` or `RuntimeAdapter`. A use case never imports a concrete adapter.

- **Why:** a test swaps the port for a fake, and an adapter can change without touching the use case.
- **Enforced by:** Biome `noNodejsModules` and `noRestrictedImports` on `packages/agents/src` and `packages/orchestration/src` block Node, platform and runtime SDK imports, and `scripts/check-layers.mjs` blocks adapter packages. Review covers ports in `apps/server`.
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

### STD-ARCH-012 Functions stay under the complexity limit

A function's cyclomatic complexity stays at 15 or below. The count starts at 1 and adds 1 for each `if`, loop, `catch`, `case`, ternary, `&&`, `||`, `??`, logical assignment, default value and optional call or member access, as in ESLint's `complexity` rule. Nested functions count on their own. Above 15, split the function into named steps or move a branch table into data.

An older function above the limit keeps a `// complexity-ignore: <reason>` comment just above it until someone splits it. Add a new one only with a reason that says why the function cannot be split. The check fails on a marker with no reason and on a marker that no longer allows anything.

- **Why:** a function with few paths is easier to read, test and review, for people and coding agents alike.
- **Enforced by:** `scripts/check-complexity.mjs` in `pnpm check` (`pnpm lint:complexity`), with its own tests in `scripts/complexity.test.mjs`.
- **Applies to:** every tracked JavaScript and TypeScript file Biome checks.

## State and events

These rules come from [ADR 037](../decisions/037-chat-and-camps.md). The [state and events contract](../architecture/state-and-events.md) shows each one in this codebase, with the file to copy from.

### STD-ARCH-013 Every lifecycle is one explicit machine

Declare each lifecycle with `defineMachine` in `@hobbots/domain`: its states, events, guards and next states in one table, and a pure `transition(state, event)` that returns the next state or `IllegalTransition` (STD-EFFECT-004). A guard reads only the machine's state and the event. The state lives in one field and changes only through `transition`. Other code asks the machine's helpers, such as `canArchive`, and never compares its state field. Never spread a state over several booleans, nullable timestamps, or `Set`s and `Map`s keyed by an id.

- ✅ `ThreadRun.transition(run, { _tag: "Stopped" })`, then `ThreadRun.isRunning(next)`
- ❌ `busy.has(threadId) || holdBack.has(threadId)`
- **Why:** one table lists every legal combination, so a new path cannot forget one, and a model-based test and a diagram can read it.
- **Enforced by:** `scripts/check-implicit-state.mjs` in `pnpm check` (`pnpm lint:state`), which fails on a `Set` or `Map` keyed by an id held for a service's or module's life, with today's cases in `scripts/implicit-state-baseline.json`, a list that only shrinks; and review. The state-comparison and diagram checks join it with `defineMachine` ([#1370](https://github.com/otaviobarros/hobbots/issues/1370)).
- **Applies to:** `packages/*`, `apps/server`.

### STD-ARCH-014 A command commits state, journal and backpack together

A command that changes durable state is one Effect service method per aggregate. It loads at an expected revision, runs the machine's transition, and writes the state, its journal entries and its backpack items in one transaction, with an idempotency key. Nothing external happens before the commit: no runtime call, no model call, no HTTP request. A model's work runs later in a projector (STD-ARCH-016).

- **Why:** a crash then leaves either the whole change or none of it, and a retried request changes nothing twice. See [ADR 013](../decisions/013-event-journal.md) and [ADR 037](../decisions/037-chat-and-camps.md).
- **Enforced by:** crash-midway tests (STD-TEST-002) and review.
- **Applies to:** `packages/*`, `apps/server`.

### STD-ARCH-015 Each transition journals one past-tense event

Every transition of a machine writes exactly one journal event, named in the past tense for what happened, such as `ChapterStarted` or `DecisionSuperseded`, in the same transaction. The journal is the only order of events. Clients and projectors learn of changes only from it.

- **Why:** one event per change makes the journal a complete history that sync, projectors and tests can replay.
- **Enforced by:** model-based tests that count events per transition, and review.
- **Applies to:** `packages/*`, `apps/server`.

### STD-ARCH-016 Derived work runs in cursor projectors

Work derived from what happened, such as a summary, a brief or a search index, runs in a projector. It reads the journal after its saved cursor, is idempotent by entry id, saves its cursor per batch, and writes its result as a record with the cursor it used, as memory capture does. An event handler never writes to another aggregate directly. A rule that must hold at once runs as a pure function inside the command's transaction instead, like `backpackItemsFor`.

- **Why:** a slow or failed model call never blocks a turn, a restart resumes where it stopped, and the order of writes stays visible.
- **Enforced by:** restart tests that check nothing is written twice, and review.
- **Applies to:** `packages/*`, `apps/server`.

### STD-ARCH-017 The bus only wakes things up

The in-process bus announces committed journal entries. A receiver re-reads durable state to decide what to do, as `WakeOnArrival` does. Losing an announcement never loses work. Work for a hob goes in its backpack, never in a second queue (ADR 019).

- **Why:** an in-memory announcement is lost on restart, and the durable records are what make work survive (STD-DATA-001).
- **Enforced by:** restart-recovery tests (STD-TEST-002) and review.
- **Applies to:** `packages/*`, `apps/server`.

### STD-ARCH-018 A turn reads records, not the transcript

A runtime session starts from the context pack: briefs, active decisions, the artifacts index, the live chapter and one line per resting chapter, built by a pure function within a budget. Never replay a thread's transcript as context, except for a brain switch inside a live chapter (ADR 017). The pack never goes over its budget and never drops an active decision silently.

- **Why:** a turn's cost then follows the live topic, not the thread's length.
- **Enforced by:** snapshot tests of the pack and its `PackReport`, and review.
- **Applies to:** `packages/agents`, `packages/runtimes`.

### STD-ARCH-019 Records move, and every author is named

A record that changes place, such as a chapter and its decisions moving into a camp, is re-parented in one transaction and leaves a stub where it was. It is never copied. Every authored record carries an explicit `actor`, `{ kind: "user" | "hob" | "hub", id }`, never an implied "you".

- **Why:** two copies drift apart, and a named author keeps shared camps possible without a migration of meaning.
- **Enforced by:** review.
- **Applies to:** `packages/*`, `apps/server`.

## Guidance

- Add a DTO or a mapping layer only where a boundary needs a different shape. Pass Schemas through otherwise.

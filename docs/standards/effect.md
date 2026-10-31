# Effect standards

Backend rules for code written with Effect. [ADR 001](../decisions/001-effect-v4.md) records the choice.

### STD-EFFECT-001 Backend code and the HTTP API use Effect v4

Write server code, the HTTP API and shared contracts with Effect v4. Contracts are Effect Schemas, so one definition validates input, encodes output and gives the type.

- **Why:** one runtime gives typed errors, dependency injection, resource safety and interruption in every package.
- **Enforced by:** review.
- **Applies to:** `apps/server` and every package except `packages/ui`.

### STD-EFFECT-002 Expected failures are typed errors

Model each expected failure as a tagged error in the Effect error channel, for example `class RuntimeError extends Schema.TaggedError<RuntimeError>()(…)`. Throw only for defects: bugs that no caller can handle.

- **Why:** the type of an Effect then lists every failure a caller must handle.
- **Enforced by:** typecheck and review.
- **Applies to:** Effect code.

### STD-EFFECT-003 Dependencies are services provided by Layers

Define each dependency as a `Context.Service` and provide its implementation with a Layer. Code reads a service from the context and never imports a concrete implementation (STD-ARCH-003).

- **Why:** a test provides a fake Layer, and composition decides the real one in one place.
- **Enforced by:** review.
- **Applies to:** Effect code.

### STD-EFFECT-004 State transitions are pure functions

Write each state machine as a pure function that takes the current state and an event and returns the next state. Effects run around the transition, not inside it.

- **Why:** a pure transition is tested exhaustively without I/O, and a replay gives the same result.
- **Enforced by:** review.
- **Applies to:** `packages/domain` and feature packages.

### STD-EFFECT-005 Effect packages share one exact version

Every `effect` and `@effect/*` dependency is declared as `catalog:`. The `catalog` in `pnpm-workspace.yaml` holds one exact version for each, all at the same release. Add a new one with `pnpm add <pkg>@catalog:` after you add it to the catalog. Upgrade them together in the catalog and run `pnpm check`. Isolate an unstable API behind a module of your own, so an upgrade changes one place.

- **Why:** Effect v4 packages move together, and a mixed set fails in ways the types do not show.
- **Enforced by:** the workspace catalog, and review.
- **Applies to:** every `package.json`.

# Domain package

The domain package holds records, machines and the pure rules beside them. These rules add to the root [AGENTS.md](../../AGENTS.md).

## Code Review Rules

- Domain code does no I/O and imports only `effect` and other domain modules (STD-ARCH-002). Transitions are pure functions (STD-EFFECT-004), and expected failures are typed errors (STD-EFFECT-002).
- A lifecycle is one machine (STD-ARCH-013), declared as the whole value of its own export: `export const XMachine = defineMachine<State, Event, Record, Error>({...})`. It is named after its record and keeps its own error type. Helpers are a separate export. [State and events](../../docs/architecture/state-and-events.md) has the conventions.
- A machine's module and everything it imports use only erasable TypeScript, with no enums and no parameter properties, because the machine scripts load it with Node's type stripping.
- A new or changed rule has a model test with `agreesWithModel` from `@hobbots/domain/machine-testing`. The model tracks every field a rule writes. Pure logic has unit tests (STD-TEST-003).
- A new state or event changes what other code may do. Check each caller of the machine's `can` and helpers in other packages, and the contract and ADR that describe the machine (STD-DOCS-002).
- Domain code returns codes, never display text (STD-I18N-005).

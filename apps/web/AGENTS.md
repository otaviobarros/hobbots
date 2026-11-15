# Web app

The web app holds the routes and screens every client shows. These rules add to the root [AGENTS.md](../../AGENTS.md).

## Code Review Rules

- Read the [React](../../docs/standards/react.md), [UI](../../docs/standards/ui.md) and [i18n](../../docs/standards/i18n.md) standards. A component change touches all three.
- Screens match the [design specification](../../docs/design/ui-ux.md) and the [screen inventory](../../docs/design/screens-and-flows.md) (STD-UI-005).
- Server state comes only from query hooks (STD-REACT-001). A client shows the hub's status and never works one out from messages or Task states (STD-REACT-028). A multi-step flow is a reducer with one type per state (STD-REACT-029).
- Every data section shows its loading, empty and error states (STD-REACT-015), and every failure says what went wrong and how to recover (STD-UI-009).
- User-facing copy lives in a `messages.ts` module (STD-I18N-001), and the UI calls agents hobs (STD-UI-007).
- Styles use theme tokens only (STD-UI-001) and build on the shared primitives (STD-UI-002). Every control works by keyboard and has a name (STD-UI-003).
- A UI change to a flow adds or updates its end-to-end test in `apps/web/e2e`, against the fake runtime (STD-TEST-004).

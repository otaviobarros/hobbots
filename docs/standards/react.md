# React standards

Rules for React code in the web client and the UI package. The client uses React 19, TanStack Router, TanStack Query and shadcn on Radix and Tailwind.

## State

### STD-REACT-001 Server state comes only from query hooks

Read and change server data only through the TanStack Query hooks in `apps/web/src/api/`. A component never calls `fetch` or the API client directly, and never copies query data into `useState`.

- **Why:** one cache keeps every screen consistent, and live events update it in one place.
- **Enforced by:** review.
- **Applies to:** `apps/web`.

### STD-REACT-002 Route-level state lives in the URL

Put state that defines the view, such as the selected hob, tab or filter, in route params or search params. Validate search params with a schema in the route.

- **Why:** a link, a reload or the back button restores the same view.
- **Enforced by:** review.
- **Applies to:** `apps/web`.

### STD-REACT-003 Local UI state stays local

Keep UI state in the component that owns it, with `useState` or `useReducer`. Lift it only as far as the nearest common parent. A global client store (Zustand, Redux, Jotai or similar) needs an ADR first. [ADR 016](../decisions/016-client-stores-outside-react.md) records the outbox and the draft store.

- **Why:** most UI state has one owner, and a global store hides who changes it.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-004 Effects only sync with external systems

Use `useEffect` only to sync with something outside React: a subscription, the DOM, a timer or browser storage. Compute derived values during render, and handle user actions in event handlers. Fetch data with query hooks (STD-REACT-001). React's [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) lists the patterns.

- **Why:** an effect that derives state renders twice and hides the data flow.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

## Components

### STD-REACT-005 Components are grouped by feature

Group web components in a folder per feature, for example `components/hob-profile/` or `components/onboarding/`. Put product-neutral primitives in `packages/ui`.

- **Why:** a feature's components, helpers and tests sit together and move together.
- **Enforced by:** review.
- **Applies to:** `apps/web/src/components`.

### STD-REACT-006 Component files stay small

Split a component file when it passes about 300 lines or holds several unrelated components. Small private subcomponents may stay in the file of the component that uses them.

- **Why:** a small file is easy to read, review and test.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-007 Kebab-case files and named exports

Name files in kebab-case, for example `hob-profile.tsx`. Export with named exports only. Config files that a tool requires to use a default export are the exception.

- **Why:** names match across imports, search results and file trees.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-008 Composition over boolean props

Give a component variations through `children`, slots or compound components. Add a boolean prop only for a true on/off state, never to switch between layouts.

- ✅ `<Card><CardHeader>…</CardHeader></Card>`
- ❌ `<Card showHeader isCompact hideFooter />`
- **Why:** each boolean doubles the states a component must handle and test.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-009 Logic lives outside JSX

Move non-trivial derivation and decisions out of the component into pure functions in the feature folder. Test them with unit tests, without rendering. `apps/web/src/lib/hob-state.ts` is an example.

- **Why:** a pure function is cheap to test, and the component stays a view.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

## Hooks and performance

### STD-REACT-010 Memoize only for a measured problem

Use `useMemo`, `useCallback` or `memo` only to fix a performance problem you measured. Add a comment that names the problem. The React Compiler is planned to memoize the rest automatically.

- **Why:** manual memoization adds code and dependency bugs, and usually saves nothing.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-011 Hooks follow the rules of hooks

Call hooks only at the top level of a component or another hook, and list every dependency.

- **Why:** React relies on call order, and a missing dependency reads stale values.
- **Enforced by:** Biome `useExhaustiveDependencies` and `useHookAtTopLevel`.
- **Applies to:** `apps/web`, `packages/ui`.

# React standards

Rules for React code in the web client and the UI package. The client uses React 19, TanStack Router, TanStack Query, Effect Schema, and shadcn on Radix and Tailwind.

Every rule names the tool that enforces it. A rule says "review" only when it needs judgment that a tool cannot make. Where a rule allows an exception, the exception is a comment in the form of [STD-REACT-020](#std-react-020-every-opt-out-names-its-rule-and-a-reason). The checks for the React, UI, i18n and testing rules land in [#803](https://github.com/otaviobarros/hobbots/issues/803). Until then, review enforces them.

## State

### STD-REACT-001 Server state comes only from query hooks

Read and change server data only through the TanStack Query hooks in `apps/web/src/api/`. A component never calls `fetch` or the API client directly, and never copies query data into `useState`.

- **Why:** one cache keeps every screen consistent, and live events update it in one place.
- **Enforced by:** review.
- **Applies to:** `apps/web`.

### STD-REACT-002 Route-level state lives in the URL

Put state that defines the view, such as the selected hob, tab or filter, in route params or search params. Each route's `validateSearch` is an Effect Schema, passed through `Schema.toStandardSchemaV1`, which TanStack Router accepts without an adapter. A missing or invalid param falls back to its default and never shows an error screen.

- ✅ `validateSearch: Schema.toStandardSchemaV1(HobsSearch)`
- ❌ `validateSearch: (search) => ({ show: isHobFilter(search.show) ? search.show : undefined })`
- **Why:** a link, a reload or the back button restores the same view, and one schema states what the URL may hold (STD-DUP-004).
- **Enforced by:** the frontend check in `pnpm check`, which fails on a `validateSearch` that is not a schema.
- **Applies to:** `apps/web`.

### STD-REACT-003 Local UI state stays local

Keep UI state in the component that owns it, with `useState` or `useReducer`. Lift it only as far as the nearest common parent. A global client store (Zustand, Redux, Jotai or similar) needs an ADR first. [ADR 016](../decisions/016-client-stores-outside-react.md) records the outbox and the draft store.

- **Why:** most UI state has one owner, and a global store hides who changes it.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-004 Effects only sync with external systems

Use `useEffect` only to sync with something outside React: a subscription, the DOM, a timer or a connection. Compute derived values during render, and handle user actions in event handlers. Fetch data with query hooks (STD-REACT-001). In particular:

- An effect that subscribes, connects or starts a timer returns a cleanup that undoes it, so it behaves the same when Strict Mode runs it twice in development.
- Reset a component's state when a prop changes by giving it a `key`, not with an effect.
- Read an external store with `useSyncExternalStore`, as the outbox and the draft store do ([ADR 016](../decisions/016-client-stores-outside-react.md)).
- Run work that happens once per app load at module level, not in an effect.
- Read the latest props or state inside an effect through `useEffectEvent`, never by leaving a dependency out.

React's [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) and [Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects) explain the patterns.

- **Why:** an effect that derives state renders twice and hides the data flow, and an effect without cleanup leaks or doubles its work.
- **Enforced by:** Strict Mode in `apps/web/src/main.tsx`, Biome `useExhaustiveDependencies`, and review.
- **Applies to:** `apps/web`, `packages/ui`.

## Components

### STD-REACT-005 Components are grouped by feature

Put every web component in a folder per feature, for example `components/hob-profile/` or `components/onboarding/`. No `.tsx` file sits at the root of `components/`. Put product-neutral primitives in `packages/ui`.

- **Why:** a feature's components, helpers and tests sit together and move together.
- **Enforced by:** the frontend check in `pnpm check`, which fails on a `.tsx` file at the root of `apps/web/src/components`.
- **Applies to:** `apps/web/src/components`.

### STD-REACT-006 Component files stay small

A `.tsx` file has at most 250 lines, and its JSX nests at most 6 elements deep. Split a file that grows past either limit. Small private subcomponents may stay in the file of the component that uses them. A file that must stay longer carries an opt-out with its reason (STD-REACT-020).

- **Why:** a small, shallow file is easy to read, review and test.
- **Enforced by:** the frontend check in `pnpm check`.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-007 Kebab-case files and named exports

Name files in kebab-case, for example `hob-profile.tsx`. Export with named exports only. Config files that a tool requires to use a default export are the exception.

- **Why:** names match across imports, search results and file trees.
- **Enforced by:** Biome `noDefaultExport`, with an override for config files, and the frontend check in `pnpm check` for file names.
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

The React Compiler memoizes components and hooks at build time. Do not write `useMemo`, `useCallback` or `memo` by hand. Use one only to fix a performance problem you measured that the compiler does not solve, with a `biome-ignore` comment that names the problem (STD-REACT-020).

- **Why:** the compiler memoizes more precisely than hand-written code, and manual memoization adds code and dependency bugs.
- **Enforced by:** the React Compiler in the web app's Vite config, and Biome `noRestrictedImports` on `useMemo`, `useCallback` and `memo` from `react`.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-011 Hooks follow the rules of hooks

Call hooks only at the top level of a component or another hook, and list every dependency.

- **Why:** React relies on call order, and a missing dependency reads stale values.
- **Enforced by:** Biome `useExhaustiveDependencies` and `useHookAtTopLevel`.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-012 A live event cancels a list's read before it reads it again

When a live event invalidates a list query, first `await queryClient.cancelQueries` for that key, then invalidate it, as `grantsChanged` and `devicesChanged` do. A plain invalidation is enough only for a query that always has data before an event can reach it.

- **Why:** while a list has no data yet, TanStack Query hands back the read already in flight instead of starting another. That read may have been taken before the change, so the screen shows the old list until something reads it again.
- **Enforced by:** review, and a unit test per list that answers the first read after the event.
- **Applies to:** `apps/web`.

## Component API

### STD-REACT-013 Components are plain functions with typed props

Write every component as a plain function. Type its props as `React.ComponentProps<"element">` or the props of the component it wraps, plus its own props. Pass `ref` as a normal prop, as React 19 allows. Do not use `forwardRef` or `React.FC`.

- **Why:** one shape for every component keeps them easy to read and to compose, and the old wrappers add nothing in React 19.
- **Enforced by:** Biome `noRestrictedImports` on `forwardRef` and `FC` from `react`.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-021 Components are never defined inside components

Define every component at the top level of a module. A component declared inside another one is a new type on every render, so React throws away its state and DOM each time.

- **Why:** the nested component loses focus, input and state on every render of its parent.
- **Enforced by:** Biome `noNestedComponentDefinitions`.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-022 Conditional rendering never leaks a number

Render conditionally with a ternary or a boolean, never with a number on the left of `&&`. Write `items.length > 0 && …` or `items.length ? … : null`, not `items.length && …`.

- **Why:** `0 && <List />` renders a stray `0` on screen.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

## Loading, errors and input

### STD-REACT-014 Every route has an error screen

Every route sets an `errorComponent`, and the router sets a `defaultErrorComponent` for anything a route does not catch. The error screen follows STD-UI-009: it says what went wrong and offers a way to recover, such as retrying, going back or going Home. A render error never leaves a blank window.

- **Why:** an error in one screen must not take down the whole app, and the user always needs a way out.
- **Enforced by:** the frontend check in `pnpm check`, which fails on a route without `errorComponent` or a router without `defaultErrorComponent`.
- **Applies to:** `apps/web`.

### STD-REACT-015 Data sections show their loading, empty and error states

Read data with `useQuery` and handle its states explicitly. Do not use Suspense for data. Each section that shows server data has a loading state, an empty state and an error state with a retry, built from the shared primitives in `packages/ui`, such as `Empty`, not from one-off markup.

- **Why:** the user always sees what is happening, and every section handles the same states the same way.
- **Enforced by:** review, and end-to-end tests that cover the empty and error states of each flow (STD-TEST-004).
- **Applies to:** `apps/web`.

### STD-REACT-016 Mutations show progress and keep the user's input

Change server data with TanStack Query mutations, not React form actions. While a mutation is pending, its control shows progress and cannot be triggered again. When it fails, the user's input stays where it was, and the error follows STD-UI-009. Update the cache optimistically only for actions that rarely fail, such as archive or pin, and roll back on failure.

- **Why:** a double submit or a lost draft costs the user's trust, and mutations already feed the query cache and the live events (STD-REACT-001).
- **Enforced by:** review, and end-to-end tests of the pending and failure paths.
- **Applies to:** `apps/web`.

### STD-REACT-017 Forms validate with an Effect Schema

Each form keeps its field rules in an Effect Schema next to it, and checks them in the client before it sends. A field shows its error inline, in plain words, when it loses focus and again on submit. Server errors map to the field they belong to when they can.

- **Why:** one schema states the rules once (STD-DUP-004), and the user learns what to fix where they are typing.
- **Enforced by:** review, and unit tests of each form schema (STD-TEST-003).
- **Applies to:** `apps/web`.

### STD-REACT-018 Context holds only app-wide values

Use React Context only for values that the whole app shares and that rarely change, such as the theme or the API client. Pass everything else as props, or keep it in the URL or local state (STD-REACT-002, STD-REACT-003).

- **Why:** context hides where data comes from, and a changing context re-renders every reader.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

## Performance

### STD-REACT-023 Routes and heavy features load when they are needed

Load each route's component lazily with TanStack Router's lazy route loading. Load heavy features that not every screen uses, such as code highlighting in replies or the diff viewer, through a dynamic `import()` at the point of use.

- **Why:** the window opens faster when it does not parse code for screens the user has not opened.
- **Enforced by:** review of the build's chunk report.
- **Applies to:** `apps/web`.

### STD-REACT-024 Long lists render only what is on screen

A list that can grow without bound, such as a chat transcript, a hob's history or the archive, renders only the rows near the viewport. Start with CSS `content-visibility: auto` on each row. Add a virtualizer only when a measurement shows that is not enough.

- **Why:** a long thread must scroll and type as smoothly as a new one.
- **Enforced by:** review.
- **Applies to:** `apps/web`.

### STD-REACT-025 Slow updates never block typing

When typing or another urgent input triggers a slow render, such as filtering a long list or search results, mark the slow part as non-urgent with `useTransition` or `useDeferredValue`.

- **Why:** the input must answer every key press at once, even while the results catch up.
- **Enforced by:** review.
- **Applies to:** `apps/web`.

## Types and exceptions

### STD-REACT-019 No any, ts-ignore or double casts

Do not write `any`, `@ts-ignore` or `as unknown as`. Parse untrusted data with an Effect Schema instead: browser storage, URL params and messages from the desktop app. Use `@ts-expect-error` only with a reason on the same line.

- **Why:** each escape hatch turns off the strict compiler settings exactly where data is least trusted.
- **Enforced by:** Biome `noExplicitAny` and `noTsIgnore` at error level, and the frontend check in `pnpm check` for `as unknown as`.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-020 Every opt-out names its rule and a reason

When a rule allows an exception, mark it with a comment in one form: `// standards-allow STD-XXX-NNN: <reason>`. A `biome-ignore` or `@ts-expect-error` comment also gives its reason, and names the rule when one applies.

- ✅ `// standards-allow STD-REACT-006: the generated table of every charm stays in one file`
- ❌ `// biome-ignore lint/style/noJsxLiterals: ok`
- **Why:** one form lets an audit list every exception with one search, so none hides.
- **Enforced by:** the frontend check in `pnpm check`, which fails on an opt-out without a rule ID or a reason.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-REACT-026 Stored data is versioned and parsed

Data the client keeps in browser storage carries a version in its key or value, and is parsed with an Effect Schema when it is read. Data that fails to parse is dropped or migrated, never trusted. Store only what the client needs.

- **Why:** an older or newer build, or another window, can leave data in a shape the current code does not expect.
- **Enforced by:** review, and unit tests of each stored shape (STD-TEST-003).
- **Applies to:** `apps/web`.

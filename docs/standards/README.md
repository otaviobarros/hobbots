# Engineering standards

These are the rules every change follows, for people and coding agents. Each rule has a stable ID, so a plan, a review or a commit can cite it.

## Find a rule

Search the index for an area prefix or a word, then read the rule in its area file:

```sh
grep -n "STD-REACT" docs/standards/README.md
grep -rn "### STD-REACT-004" docs/standards
```

| Prefix | Area | File |
|---|---|---|
| `STD-ARCH` | Layers, boundaries and packages | [architecture.md](architecture.md) |
| `STD-DUP` | Reuse, dead code and duplication | [duplication.md](duplication.md) |
| `STD-EFFECT` | Backend code with Effect | [effect.md](effect.md) |
| `STD-DATA` | Durable state and SQL | [data.md](data.md) |
| `STD-SEC` | Permissions, authority and untrusted input | [security.md](security.md) |
| `STD-REACT` | React state, components and hooks | [react.md](react.md) |
| `STD-UI` | Styling, design and accessibility | [ui.md](ui.md) |
| `STD-I18N` | Internationalization | [i18n.md](i18n.md) |
| `STD-DESKTOP` | The Electron app | [desktop.md](desktop.md) |
| `STD-TEST` | Tests and verification | [testing.md](testing.md) |
| `STD-DOCS` | Docs, decisions and workflow | [docs.md](docs.md) |

## Rule format

Each rule is a level-three heading with its ID and title, followed by the rule and three fields:

```md
### STD-REACT-004 Effects only sync with external systems

The rule, in one or two short paragraphs.

- **Why:** the reason, in one sentence.
- **Enforced by:** the tool and its config, or "review".
- **Applies to:** the paths or packages.
```

Add a ✅/❌ example only when the rule is not obvious. Every rule with an ID is a "must", and review can block on it. A preference that is only advice goes in the "Guidance" section at the end of the area file, without an ID.

## Change a rule

1. Edit the rule in its area file and its row in the index, in the same pull request.
2. Give a new rule the next free number in its area. Never reuse or renumber an ID.
3. To retire a rule, delete its heading and mark its index row `Retired`. The ID stays reserved.
4. Write an ADR only when the change reverses a decided architecture choice.

`pnpm check` runs `scripts/check-standards.mjs`. It fails when:

- two rules share an ID,
- a rule is missing from the index,
- the index lists an active rule that no area file defines,
- a title differs between the index and the rule,
- a retired ID comes back,
- a rule sits in the wrong area file,
- an ADR does not end with a Validation section that lists scenarios (STD-DOCS-009),
- an evidence record misses a field or the status page does not link it (STD-DOCS-010).

## Index

| ID | Rule | Status |
|---|---|---|
| STD-ARCH-001 | Dependencies point inward through four layers | Active |
| STD-ARCH-002 | Domain code is pure | Active |
| STD-ARCH-003 | Use cases reach the outside world through ports | Active |
| STD-ARCH-004 | Adapters own all I/O | Active |
| STD-ARCH-005 | Apps only compose and expose | Active |
| STD-ARCH-006 | Use cases live in their feature package | Active |
| STD-ARCH-007 | Split files and folders when they grow | Active |
| STD-ARCH-008 | Domain identity stays independent of runtimes and transports | Active |
| STD-ARCH-009 | Hobs run on existing runtimes through capability-aware adapters | Active |
| STD-ARCH-010 | Every hob has the same capabilities | Active |
| STD-ARCH-011 | One hub serves every client | Active |
| STD-ARCH-012 | Functions stay under the complexity limit | Active |
| STD-ARCH-013 | Every lifecycle is one explicit machine | Active |
| STD-ARCH-014 | A command commits state, journal and backpack together | Active |
| STD-ARCH-015 | Each transition journals one past-tense event | Active |
| STD-ARCH-016 | Derived work runs in cursor projectors | Active |
| STD-ARCH-017 | The bus only wakes things up | Active |
| STD-ARCH-018 | A turn reads records, not the transcript | Active |
| STD-ARCH-019 | Records move, and every author is named | Active |
| STD-DUP-001 | Search before writing | Active |
| STD-DUP-002 | Extract logic at its second real copy | Active |
| STD-DUP-003 | Shared code lives in the layer that owns it | Active |
| STD-DUP-004 | Effect Schemas are the single source of a contract | Active |
| STD-DUP-005 | No unused files, exports or dependencies | Active |
| STD-DUP-006 | No copied blocks of code | Active |
| STD-DUP-007 | Use what installed libraries provide before writing your own | Active |
| STD-EFFECT-001 | Backend code and the HTTP API use Effect v4 | Active |
| STD-EFFECT-002 | Expected failures are typed errors | Active |
| STD-EFFECT-003 | Dependencies are services provided by Layers | Active |
| STD-EFFECT-004 | State transitions are pure functions | Active |
| STD-EFFECT-005 | Effect packages share one exact version | Active |
| STD-DATA-001 | Coordination state is durable | Active |
| STD-DATA-002 | SQL stays PostgreSQL-compatible | Active |
| STD-SEC-001 | Hobs default to Trusted Workspace autonomy | Active |
| STD-SEC-002 | Permissions are enforced at real boundaries | Active |
| STD-SEC-003 | Delegation never widens authority | Active |
| STD-SEC-004 | Hobbots MCP controls exclude administrative powers | Active |
| STD-SEC-005 | Patterns on untrusted text run in linear time | Active |
| STD-REACT-001 | Server state comes only from query hooks | Active |
| STD-REACT-002 | Route-level state lives in the URL | Active |
| STD-REACT-003 | Local UI state stays local | Active |
| STD-REACT-004 | Effects only sync with external systems | Active |
| STD-REACT-005 | Components are grouped by feature | Active |
| STD-REACT-006 | Component files stay small | Active |
| STD-REACT-007 | Kebab-case files and named exports | Active |
| STD-REACT-008 | Composition over boolean props | Active |
| STD-REACT-009 | Logic lives outside JSX | Active |
| STD-REACT-010 | Memoize only for a measured problem | Active |
| STD-REACT-011 | Hooks follow the rules of hooks | Active |
| STD-REACT-012 | A live event cancels a list's read before it reads it again | Active |
| STD-REACT-013 | Components are plain functions with typed props | Active |
| STD-REACT-014 | Every route has an error screen | Active |
| STD-REACT-015 | Data sections show their loading, empty and error states | Active |
| STD-REACT-016 | Mutations show progress and keep the user's input | Active |
| STD-REACT-017 | Forms validate with an Effect Schema | Active |
| STD-REACT-018 | Context holds only app-wide values | Active |
| STD-REACT-019 | No any, ts-ignore or double casts | Active |
| STD-REACT-020 | Every opt-out names its rule and a reason | Active |
| STD-REACT-021 | Components are never defined inside components | Active |
| STD-REACT-022 | Conditional rendering never leaks a number | Active |
| STD-REACT-023 | Routes and heavy features load when they are needed | Active |
| STD-REACT-024 | Long lists render only what is on screen | Active |
| STD-REACT-025 | Slow updates never block typing | Active |
| STD-REACT-026 | Stored data is versioned and parsed | Active |
| STD-REACT-027 | Query hooks own an async call's lifecycle | Active |
| STD-REACT-028 | Clients render hub state, never derive it | Active |
| STD-REACT-029 | A flow is a reducer with one type per state | Active |
| STD-UI-001 | Styles use theme tokens only | Active |
| STD-UI-002 | Build on the shared primitives | Active |
| STD-UI-003 | Every control works by keyboard and has a name | Active |
| STD-UI-004 | Motion is stepped and stops with Reduce motion | Active |
| STD-UI-005 | Screens match the design specification | Active |
| STD-UI-006 | Selection uses a fill, never a left-edge accent | Active |
| STD-UI-007 | The UI calls agents hobs | Active |
| STD-UI-008 | Durable records drive every status | Active |
| STD-UI-009 | Every failure says what went wrong and how to recover | Active |
| STD-UI-010 | Only primitives take a className, and only for layout | Active |
| STD-UI-011 | Visual variants come from cva | Active |
| STD-UI-012 | Conditional and joined classes go through cn | Active |
| STD-I18N-001 | User-facing copy lives in message modules | Active |
| STD-I18N-002 | Messages are whole sentences with placeholders | Active |
| STD-I18N-003 | Dates and numbers use shared locale formatters | Active |
| STD-I18N-004 | Layout survives longer text and right-to-left scripts | Active |
| STD-I18N-005 | Server and domain code return codes, not display text | Active |
| STD-DESKTOP-001 | Renderers are isolated and sandboxed | Active |
| STD-DESKTOP-002 | The preload exposes a narrow, typed bridge | Active |
| STD-DESKTOP-003 | Every IPC handler checks its sender and parses its input | Active |
| STD-DESKTOP-004 | Navigation, new windows and external links are limited | Active |
| STD-DESKTOP-005 | Permission requests are denied unless allowed | Active |
| STD-DESKTOP-006 | Pages load over the app protocol with a strict CSP | Active |
| STD-DESKTOP-007 | The packaged app flips Electron's fuses | Active |
| STD-DESKTOP-008 | The main process never blocks | Active |
| STD-DESKTOP-009 | Electron stays on a supported release | Active |
| STD-DESKTOP-010 | A window never flashes blank or fails silently | Active |
| STD-TEST-001 | Integration and end-to-end tests carry a case ID | Active |
| STD-TEST-002 | Fakes first, then the real runtime | Active |
| STD-TEST-003 | Pure logic has unit tests | Active |
| STD-TEST-004 | Each user flow has an end-to-end test | Active |
| STD-TEST-005 | Component tests only where end-to-end cannot reach | Active |
| STD-TEST-006 | Database tests run on SQLite and PostgreSQL | Active |
| STD-TEST-007 | Every end-to-end screen passes an accessibility scan | Active |
| STD-TEST-008 | Each main flow works by keyboard alone | Active |
| STD-TEST-009 | Tests wait on state, and a flaky test is a bug | Active |
| STD-TEST-010 | The window never scrolls | Active |
| STD-DOCS-001 | Decided choices change only through an ADR | Active |
| STD-DOCS-002 | Read the contract before changing its area | Active |
| STD-DOCS-003 | Public text links only public sources | Active |
| STD-DOCS-004 | Commits follow Conventional Commits | Active |
| STD-DOCS-005 | Library knowledge comes from current docs | Active |
| STD-DOCS-006 | Dependencies take the latest stable release, pinned exactly | Active |
| STD-DOCS-007 | Docs use short, plain sentences | Active |
| STD-DOCS-008 | Work stays inside the requested scope | Active |
| STD-DOCS-009 | An ADR ends with the scenarios that validate it | Active |
| STD-DOCS-010 | A proof leaves a dated evidence record | Active |
| STD-DOCS-011 | UI words and code names follow the glossary | Active |

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
| `STD-SEC` | Permissions and authority | [security.md](security.md) |
| `STD-REACT` | React state, components and hooks | [react.md](react.md) |
| `STD-UI` | Styling, design and accessibility | [ui.md](ui.md) |
| `STD-I18N` | Internationalization | [i18n.md](i18n.md) |
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
| STD-UI-001 | Styles use theme tokens only | Active |
| STD-UI-002 | Build on the shared primitives | Active |
| STD-UI-003 | Every control works by keyboard and has a name | Active |
| STD-UI-004 | Motion is stepped and stops with Reduce motion | Active |
| STD-UI-005 | Screens match the design specification | Active |
| STD-UI-006 | Selection uses a fill, never a left-edge accent | Active |
| STD-UI-007 | The UI calls agents hobs | Active |
| STD-UI-008 | Durable records drive every status | Active |
| STD-I18N-001 | User-facing copy lives in message modules | Active |
| STD-I18N-002 | Messages are whole sentences with placeholders | Active |
| STD-I18N-003 | Dates and numbers use shared locale formatters | Active |
| STD-I18N-004 | Layout survives longer text and right-to-left scripts | Active |
| STD-I18N-005 | Server and domain code return codes, not display text | Active |
| STD-TEST-001 | Integration and end-to-end tests carry a case ID | Active |
| STD-TEST-002 | Fakes first, then the real runtime | Active |
| STD-TEST-003 | Pure logic has unit tests | Active |
| STD-TEST-004 | Each user flow has an end-to-end test | Active |
| STD-TEST-005 | Component tests only where end-to-end cannot reach | Active |
| STD-TEST-006 | Database tests run on SQLite and PostgreSQL | Active |
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

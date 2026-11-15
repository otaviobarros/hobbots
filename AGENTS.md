# Hobbots — instructions for coding agents

## Scope

The code grew from the first validation slice of [ADR 009](docs/decisions/009-toolchain-and-validation-slice.md). Today it runs hobs on Claude Code and Codex, with persistent threads, Tasks and Quests, in the browser and Electron. Work from the requested scope (STD-DOCS-008). The docs describe the system and do not authorize you to build it.

## Commands

- `pnpm check` runs the standards check (rule index, ADR validation sections, evidence records), the layer check, the complexity check, the implicit-state check, knip, jscpd, Biome, typecheck and tests. Run it before you hand work back.
- `pnpm test:pg` runs the persistence and server suites on PostgreSQL. Run it when a change touches SQL, migrations or repositories. It needs Docker.
- `pnpm migration:new <name>` adds a persistence migration named by the current UTC second. Never number one by hand or list it anywhere ([ADR 040](docs/decisions/040-parallel-pull-requests.md)).
- `pnpm add <pkg>` adds a dependency at its latest stable release, pinned exactly (STD-DOCS-006). Effect packages use the workspace catalog (STD-EFFECT-005).

## Standards

Every change follows the [engineering standards](docs/standards/README.md). Before you change an area, read its standards file and its contract. Cite rule IDs such as `STD-REACT-004` in plans and reviews. The `hobbots-standards` skill walks through this.

| Area                        | Standards                                                                                    | Contracts                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layers and packages         | [architecture](docs/standards/architecture.md), [duplication](docs/standards/duplication.md) | [Architecture overview](docs/architecture/overview.md)                                                                                                   |
| Identity and sessions       | [architecture](docs/standards/architecture.md)                                               | [Agent model](docs/architecture/agent-model.md), [conversations](docs/architecture/conversations.md)                                                     |
| Delegation and scheduling   | [effect](docs/standards/effect.md), [data](docs/standards/data.md)                           | [Orchestration](docs/architecture/orchestration.md), [backpack](docs/architecture/inbox.md), [attempt lifecycle](docs/architecture/attempt-lifecycle.md) |
| State, events and camps     | [architecture](docs/standards/architecture.md), [react](docs/standards/react.md)             | [State and events](docs/architecture/state-and-events.md), [chat and camps](docs/architecture/chat-and-camps.md)                                         |
| Tools and authority         | [security](docs/standards/security.md)                                                       | [Permissions](docs/architecture/permissions.md), [runtime adapters](docs/architecture/runtime-adapters.md)                                               |
| Storage and transport       | [data](docs/standards/data.md), [effect](docs/standards/effect.md)                           | [Persistence](docs/architecture/persistence.md), [API and events](docs/architecture/api-events.md), [deployment](docs/architecture/deployment.md)        |
| UI                          | [react](docs/standards/react.md), [ui](docs/standards/ui.md), [i18n](docs/standards/i18n.md) | [Themes](docs/design/themes.md), [ADR 008](docs/decisions/008-design.md)                                                                                 |
| Desktop app                 | [desktop](docs/standards/desktop.md), [security](docs/standards/security.md)                 | [Deployment](docs/architecture/deployment.md), [ADR 010](docs/decisions/010-desktop-hub.md)                                                              |
| Tests                       | [testing](docs/standards/testing.md)                                                         | [Project workflow guide](docs/agent-engineering.md#checks)                                                                                               |
| Docs, commits and decisions | [docs](docs/standards/docs.md)                                                               | [ADRs](docs/decisions/README.md)                                                                                                                         |

Read the [vision](docs/product/vision.md) and [open questions](docs/product/open-questions.md) before you plan.

## Workflow

The [project workflow guide](docs/agent-engineering.md) says where each authority lives and lists the checks. It routes each task to an agent-engineering skill: `deliver-change` for a full implementation, or the phase skill for a narrower request. The task's own limits and this file govern. If a skill is missing, report it. This file does not authorize you to install plugins, commit, push or publish.

## Code Review Rules

Codex reviews every pull request with these rules, and with the rules of each nested `AGENTS.md` that covers a changed file. This is a public open-source project, so be strict about what reaches main. Make each pass complete: a pull request should need one review and one check of its fixes, not seven.

### Read first

- The Standards table above maps each area to its standards file and its contract. Read the contract of every area the diff touches before you judge it (STD-DOCS-002). It holds the invariants that the diff does not show.
- [The ADR index](docs/decisions/README.md) lists the decided choices. A change that reverses one without a new ADR or an amendment is a finding (STD-DOCS-001).
- [State and events](docs/architecture/state-and-events.md) says how lifecycles, commands, the journal and projectors work. The pages in `docs/architecture/machines/` show each machine's states and legal moves.
- For security, read the [threat model](docs/threat-model.md) and the security review guidelines in [SECURITY.md](SECURITY.md).
- The linked issue's "Done when" list sets the scope (STD-DOCS-008).

### Severity

- **P0:** data loss or corruption, including on upgrade, restart or restore; an enforced boundary from the threat model crossed; a secret leaked; a migration that breaks an existing install.
- **P1:** a reachable bug; a breach of a rule with an STD ID; a runtime or database the change leaves behind; a contract or ADR the change leaves out of date; a deleted, skipped or loosened test or check.
- Anything else is not a finding. Do not report P2 or P3. A preference that no rule backs is not a finding.

### What to check

Each rule names what to flag, then the safe path that is not a finding.

- **Bugs come first:** reachable failures, wrong state transitions, races, lost work on restart, duplicate delivery on retry and missing error handling. Trace callers and callees beyond the diff when the bug depends on them. Safe path: the failure is handled where it is expected, as a typed error the caller acts on (STD-EFFECT-002).
- **Sweep the whole change:** when a change breaks an assumption other code relies on, such as "the hob that owns a camp is the hob that speaks in it", find every reader of that assumption and report each one now. When one command has a bug, check its sibling commands for the same bug, such as reassign and retry, or pause, resume and cancel. Safe path: every reader handles the new case, or the PR limits the change so the old assumption still holds.
- **Durable state:** coordination or recovery state held only in memory (STD-DATA-001), a check that guards a write but reads outside the write's transaction (STD-ARCH-014), a transition that journals no event or several (STD-ARCH-015), and a record that names who acted without an Actor (STD-ARCH-020). Safe path: the state is a row, the check and the write share one transaction, and on PostgreSQL the check locks the row it reads.
- **Lifecycles:** a status kept in flags or compared by hand outside its machine (STD-ARCH-013), and a client that works out a status from messages or Task states (STD-REACT-028). Safe path: one machine declared with `defineMachine`; other code asks its `can` or helpers; clients show the hub's projection.
- **Security:** untrusted input from hobs, models, files, Git or HTTP that crosses a trust boundary unchecked, leaked secrets, missing permission checks and data exposure. The [security standards](docs/standards/security.md) hold the rules. Safe path: the input is parsed with an Effect Schema at the boundary, and the permission is enforced by the sandbox, the runtime's permission mode or the tool policy engine (STD-SEC-002).
- **Established libraries first:** a hand-rolled parser, validator, retry loop, timer, cache or queue (STD-DUP-007), Markdown read without the CommonMark parser (STD-DUP-008), or a helper that repeats an existing one (STD-DUP-001). Safe path: an installed library or Effect module, or the existing helper. A few lines of glue around a library call are not a hand-rolled parser.
- **Runtime parity:** a change to how hobs run, resume, stop, use tools or ask for permission that covers only some of Claude Code, Codex and the fake runtime (STD-ARCH-009, STD-ARCH-010). Safe path: each runtime has the change and a test, or the PR says why one does not apply, for example a capability that runtime lacks.
- **Database parity:** SQL or a migration only one of SQLite and PostgreSQL accepts (STD-DATA-002), and a database test that does not take `TestDatabase` (STD-TEST-006). Safe path: SQL both engines accept, tested on both through `TestDatabase`.
- **Migrations:** a migration not made by `pnpm migration:new`, and an edit to or renumbering of a migration that is on main ([ADR 040](docs/decisions/040-parallel-pull-requests.md)). Safe path: a new file named by its UTC second; a fix to an applied migration is a new migration.
- **Tests:** new behavior without a test, and a test that waits on elapsed time (STD-TEST-009). Safe path: the test waits on the state it checks.
- **Unneeded complexity:** speculative abstractions and options nobody uses. Safe path: name the simpler form that keeps the behavior. Code a contract or ADR asks for is not speculative.
- **Dependencies:** a version range or a version that is not the latest stable release when it was added (STD-DOCS-006), and an Effect package outside the catalog (STD-EFFECT-005). Safe path: an exact version, and `catalog:` for Effect packages.
- **Public text:** a link to a private source, a secret in code, docs or the PR (STD-DOCS-003), and an attribution footer for an AI tool, such as "Generated with", "Generated by" or "Co-Authored-By", in a commit message or the PR description. Safe path: public links only, and no footer in the commits the pull request adds or in its current description. Pull requests merge by squash, so the current description is what reaches main; an earlier version of it is not a finding.
- **Scope and contracts:** a change beyond what the linked issue asks (STD-DOCS-008), and a contract or ADR the change leaves out of date (STD-DOCS-002). Safe path: the contract or ADR changes in the same pull request. A small fix the change needs to work is in scope.

### Do not flag

- What CI already checks: formatting and lint (Biome), types, unused code (knip, STD-DUP-005), copied blocks (jscpd, STD-DUP-006), the complexity limit (STD-ARCH-012), layer imports, implicit state, stale machine pages, the glossary, the Markdown check and the standards index. Flag only what these tools cannot see.
- The message of GitHub's merge preview, the commit on `refs/pull/<n>/merge` that GitHub builds to test the pull request. GitHub writes it from the description as the pull request was first opened, so it can keep a footer the current description no longer has. It never reaches main. Check only the commits the pull request adds and its current description.
- A footer in a review comment or a reply on the pull request. Comments do not reach the repository, and the tools that post them may add one.
- Code the diff does not touch, unless the change makes its bug reachable or worse.
- A race without a concrete interleaving. Name the two operations and the window between them. A race the code already serializes, with a transaction, a row lock or hob admission, is not a finding.
- A guard for a state that the machine or the types already rule out.
- A limit the permissions contract marks as checked rather than enforced, unless the change makes the contract claim more than the code does.
- A finding a reply on this pull request already declined with a reason, unless the code it names has changed.
- Wording, naming or structure that no rule backs.

### How to report

- Report every finding in one pass. Do not hold findings back for a later pass.
- After a push, review the new commits as closely as the first pass. A fix often adds a new path; check it and the code it calls.
- When one cause shows up in several places, report it once and name each place.
- Each finding states the trigger, the wrong result, its impact and the fix. Cite the STD rule ID, or the contract file and section it breaks.

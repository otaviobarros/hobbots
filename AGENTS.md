# Hobbots — instructions for coding agents

## Workflow

Work goes through the [agent-engineering](https://github.com/otaviobarros/agent-engineering) skills:

| Task                     | Skill                |
| ------------------------ | -------------------- |
| An issue to build        | `deliver-change`     |
| A plan only              | `plan-change`        |
| A pull request to review | `review-pr`          |
| Review findings to fix   | `remediate-findings` |

The [project workflow guide](docs/agent-engineering.md) lists the other skills, where each authority lives and the checks. Run only the tests your change affects; CI runs the whole suite. The task's own limits and this file govern. If a skill is missing, report it. This file does not authorize you to install plugins, commit, push or publish.

## Scope

The code grew from the first validation slice of [ADR 009](docs/decisions/009-toolchain-and-validation-slice.md). Today it runs hobs on Claude Code and Codex, with persistent threads, Tasks and Quests, in the browser and Electron. Work from the requested scope (STD-DOCS-008). The docs describe the system and do not authorize you to build it.

## Commands

- `pnpm check` runs the standards check (rule index), the layer check, the complexity check, the implicit-state check, knip, jscpd, Biome, typecheck and tests. CI runs it on every pull request; locally, run the checks and tests your change affects.
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

## Code Review Rules

Codex reviews every pull request with these rules, and with the rules of each nested `AGENTS.md` that covers a changed file. Make each pass complete: a pull request should need one review and one check of its fixes.

### Read first

- The contract of every area the diff touches, from the Standards table above (STD-DOCS-002), and the [ADR index](docs/decisions/README.md): reversing a decided choice without a new ADR or an amendment is a finding (STD-DOCS-001).
- For security, the [threat model](docs/threat-model.md) and [SECURITY.md](SECURITY.md). The linked issue sets the scope (STD-DOCS-008).

### Severity

- **P0:** data loss or corruption, including on upgrade, restart or restore; a threat-model boundary crossed; a leaked secret; a migration that breaks an existing install.
- **P1:** a reachable bug; a breach of a rule with an STD ID; a runtime or database the change leaves behind; a contract or ADR left out of date; a deleted, skipped or loosened test or check.
- Nothing else is a finding. Do not report P2 or P3, or a preference no rule backs.

### What to check

- **Bugs first:** reachable failures, wrong transitions, races, lost work on restart, duplicate delivery on retry, missing error handling. When a change breaks an assumption other code relies on, report every reader of it, and check sibling commands for the same bug.
- **Durable state and lifecycles:** state held only in memory (STD-DATA-001), a check outside its write's transaction (STD-ARCH-014), a transition that journals no event or several (STD-ARCH-015), a record that names who acted without an Actor (STD-ARCH-020), a status kept outside its machine (STD-ARCH-013), a client that derives a status (STD-REACT-028).
- **Security:** untrusted input crossing a trust boundary unchecked, leaked secrets, missing permission checks ([security standards](docs/standards/security.md)).
- **Parity:** a change to how hobs run, resume, stop, use tools or ask permission that misses Claude Code, Codex or the fake (STD-ARCH-009, STD-ARCH-010); SQL only one of SQLite and PostgreSQL accepts, or a database test without `TestDatabase` (STD-DATA-002, STD-TEST-006).
- **Unneeded complexity:** speculative abstractions and options nobody uses; name the simpler form. Code a contract or ADR asks for is not speculative.
- **Migrations:** one not made by `pnpm migration:new`, or an edit to one on main ([ADR 040](docs/decisions/040-parallel-pull-requests.md)).
- **Libraries and tests:** a hand-rolled parser, validator, retry, timer, cache or queue (STD-DUP-007, STD-DUP-008); new behavior without a test, or a test that waits on time (STD-TEST-009).
- **Dependencies and public text:** a version range or not the latest stable (STD-DOCS-006, STD-EFFECT-005); a private link or secret (STD-DOCS-003); an AI attribution footer in a commit the PR adds or in its current description.

### Do not flag

- What CI checks: Biome, types, knip, jscpd, complexity, layers, implicit state, machine pages, the glossary, the Markdown check, the standards index.
- The message of GitHub's merge preview, the commit on `refs/pull/<n>/merge` that GitHub builds to test the pull request. GitHub writes it from the description as the pull request was first opened, so it can keep a footer the current description no longer has. It never reaches main. Check only the commits the pull request adds and its current description.
- A footer in a review comment or a reply on the pull request.
- Code the diff does not touch, unless the change makes its bug reachable or worse; a race with no concrete interleaving, or one a transaction, row lock or hob admission already serializes; a guard for a state the machine or types rule out.
- A finding a reply already declined with a reason, unless its code changed; wording, naming or structure no rule backs.

### How to report

Report every finding in one pass, and review new commits as closely as the first. Report one cause once, naming each place. Each finding states the trigger, the wrong result, its impact, the fix, and the STD rule or contract section it breaks.

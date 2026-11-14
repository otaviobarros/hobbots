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
| UI                          | [react](docs/standards/react.md), [ui](docs/standards/ui.md), [i18n](docs/standards/i18n.md) | [Design specification](docs/design/ui-ux.md), [screen inventory](docs/design/screens-and-flows.md)                                                       |
| Desktop app                 | [desktop](docs/standards/desktop.md), [security](docs/standards/security.md)                 | [Deployment](docs/architecture/deployment.md), [ADR 010](docs/decisions/010-desktop-hub.md)                                                              |
| Tests                       | [testing](docs/standards/testing.md)                                                         | [Project workflow guide](docs/agent-engineering.md#checks)                                                                                               |
| Docs, commits and decisions | [docs](docs/standards/docs.md)                                                               | [ADRs](docs/decisions/README.md), [status](docs/STATUS.md)                                                                                               |

Read the [MVP requirements](docs/product/mvp-requirements.md) and [open questions](docs/product/open-questions.md) before you plan.

## Workflow

The [project workflow guide](docs/agent-engineering.md) says where each authority lives and lists the checks. It routes each task to an agent-engineering skill: `deliver-change` for a full implementation, or the phase skill for a narrower request. The task's own limits and this file govern. If a skill is missing, report it. This file does not authorize you to install plugins, commit, push or publish.

## Review guidelines

This is a public open-source project, so be strict about what reaches main. Check the change against [the standards](docs/standards/README.md) and cite the rule ID in each finding. Mark a breach of a rule as P1. A preference that no rule backs is not a finding.

- Bugs come first: reachable failures, wrong state transitions, races, lost work on restart, duplicate delivery on retry, and missing error handling. Trace callers and callees beyond the diff when the bug depends on them.
- Security: untrusted input from hobs, models, files, Git or HTTP crossing a trust boundary, leaked secrets, missing permission checks and data exposure ([security](docs/standards/security.md)).
- Proper tooling: a hand-rolled parser, validator, retry loop, timer, cache or queue where an established library or Effect module already does the job (STD-DUP-007). A new helper that duplicates an existing one (STD-DUP-001).
- Unnecessary complexity: speculative abstractions, options nobody uses, functions over cyclomatic complexity 15 (STD-ARCH-012), dead code (STD-DUP-005) and copied blocks (STD-DUP-006). Name the simpler form that keeps the behavior.
- Runtime parity: a change to how hobs run, resume, stop, use tools or ask for permission covers Claude Code, Codex and the fake runtime, with a test for each, or says why one does not apply.
- Dependencies are pinned to exact versions (STD-DOCS-006). Effect packages use `catalog:` and the catalog pins the exact version (STD-EFFECT-005).
- A new migration comes from `pnpm migration:new` and is named by its UTC second ([ADR 040](docs/decisions/040-parallel-pull-requests.md)). Never renumber an existing one.
- Commit messages and the PR description carry no attribution footer, such as "Generated with" or "Co-Authored-By" for an AI tool.
- Scope: flag changes beyond what the linked issue asks (STD-DOCS-008), and a contract or ADR the change leaves out of date.
- Skip formatting that Biome enforces. Each finding states the trigger, the wrong result, its impact and the fix.

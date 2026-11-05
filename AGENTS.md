# Hobbots — instructions for coding agents

## Scope

The code grew from the first validation slice of [ADR 009](docs/decisions/009-toolchain-and-validation-slice.md). Today it runs hobs on Claude Code and Codex, with persistent threads, Tasks and Quests, in the browser and Electron. Work from the requested scope (STD-DOCS-008). The docs describe the system and do not authorize you to build it.

## Commands

- `pnpm check` runs the standards check (rule index, ADR validation sections, evidence records), the layer check, the complexity check, knip, jscpd, Biome, typecheck and tests. Run it before you hand work back.
- `pnpm test:pg` runs the persistence and server suites on PostgreSQL. Run it when a change touches SQL, migrations or repositories. It needs Docker.
- `pnpm add <pkg>` adds a dependency at its latest stable release, pinned exactly (STD-DOCS-006). Effect packages use the workspace catalog (STD-EFFECT-005).

## Standards

Every change follows the [engineering standards](docs/standards/README.md). Before you change an area, read its standards file and its contract. Cite rule IDs such as `STD-REACT-004` in plans and reviews. The `hobbots-standards` skill walks through this.

| Area                        | Standards                                                                                    | Contracts                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Layers and packages         | [architecture](docs/standards/architecture.md), [duplication](docs/standards/duplication.md) | [Architecture overview](docs/architecture/overview.md)                                                                                                       |
| Identity and sessions       | [architecture](docs/standards/architecture.md)                                               | [Agent model](docs/architecture/agent-model.md), [conversations](docs/architecture/conversations.md)                                                         |
| Delegation and scheduling   | [effect](docs/standards/effect.md), [data](docs/standards/data.md)                           | [Orchestration](docs/architecture/orchestration.md), [backpack](docs/architecture/inbox.md), [execution lifecycle](docs/architecture/execution-lifecycle.md) |
| Tools and authority         | [security](docs/standards/security.md)                                                       | [Permissions](docs/architecture/permissions.md), [runtime adapters](docs/architecture/runtime-adapters.md)                                                   |
| Storage and transport       | [data](docs/standards/data.md), [effect](docs/standards/effect.md)                           | [Persistence](docs/architecture/persistence.md), [API and events](docs/architecture/api-events.md), [deployment](docs/architecture/deployment.md)            |
| UI                          | [react](docs/standards/react.md), [ui](docs/standards/ui.md), [i18n](docs/standards/i18n.md) | [Design specification](docs/design/ui-ux.md), [screen inventory](docs/design/screens-and-flows.md)                                                           |
| Desktop app                 | [desktop](docs/standards/desktop.md), [security](docs/standards/security.md)                 | [Deployment](docs/architecture/deployment.md), [ADR 010](docs/decisions/010-desktop-hub.md)                                                                  |
| Tests                       | [testing](docs/standards/testing.md)                                                         | [Project workflow guide](docs/agent-engineering.md#checks)                                                                                                   |
| Docs, commits and decisions | [docs](docs/standards/docs.md)                                                               | [ADRs](docs/decisions/README.md), [status](docs/STATUS.md)                                                                                                   |

Read the [MVP requirements](docs/product/mvp-requirements.md) and [open questions](docs/product/open-questions.md) before you plan.

## Workflow

The [project workflow guide](docs/agent-engineering.md) says where each authority lives and lists the checks. It routes each task to an agent-engineering skill: `deliver-change` for a full implementation, or the phase skill for a narrower request. The task's own limits and this file govern. If a skill is missing, report it. This file does not authorize you to install plugins, commit, push or publish.

# Project workflow guide

Scope: this repository. Purpose: tell people and coding agents where each project authority lives and when to read it. This guide grants no permissions and is not evidence that any check passed. [AGENTS.md](../AGENTS.md) and the documents it links still govern.

## Where to look

| Concern | Read when | Authoritative source |
|---|---|---|
| Instructions and architectural constraints | Every task | [AGENTS.md](../AGENTS.md) |
| Product scope and requirement IDs (`AG-`, `CH-`, `OR-`, `IN-`, `EX-`, …) | Planning; writing acceptance criteria | [MVP requirements](product/mvp-requirements.md), [open questions](product/open-questions.md), [vision](product/vision.md) |
| Architecture and per-area contracts | Before changing an area; AGENTS.md maps area → contract | [Architecture overview](architecture/overview.md), [`docs/architecture/`](architecture/) |
| Decisions | Interfaces, ownership, significant tradeoffs; record deliberate changes as a new or updated ADR | [ADR index](decisions/README.md) |
| Current build scope | Any implementation; the code is the first validation slice only | [ADR 009](decisions/009-toolchain-and-validation-slice.md), [README › Status](../README.md#status) |
| UI | Changes under `apps/web`, `apps/desktop` or `packages/ui` | [Design specification](design/ui-ux.md), [screen inventory](design/screens-and-flows.md), [ADR 008](decisions/008-design.md) |
| Vocabulary | Naming domain concepts, UI copy | [Glossary](product/glossary.md) |
| Package boundaries | Adding code to a package; README-only packages are planned boundaries with no code yet | Each `apps/*/README.md` and `packages/*/README.md` |
| Issues, labels, board, commits, branches, PRs | Picking up or publishing work | [Issues and the project board](contributing/issues-and-board.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [PR template](../.github/pull_request_template.md) |
| Versions, tags, changelog, betas | Changing release configuration or cutting a release | [Releases](contributing/releases.md) |
| Dependencies | Adding a package | [AGENTS.md](../AGENTS.md) (latest stable via `pnpm add`; exact Effect v4 pins) |

## Checks

Commands live in executable configuration; read them there rather than from this guide. Working directory: repository root.

- Script catalog: root [`package.json`](../package.json) `scripts` (`check` is the required pre-PR gate per AGENTS.md and CONTRIBUTING.md); per-package scripts in each `package.json`; task graph in [`turbo.json`](../turbo.json).
- Lint/format rules: [`biome.json`](../biome.json) (`docs/` is excluded). Type strictness: [`tsconfig.base.json`](../tsconfig.base.json).
- Tests: Vitest, under `test/` or beside the source as `*.test.ts`. `packages/api` and `packages/ui` have no tests; `apps/desktop` tests its main-process helpers and build scripts, and drives a packaged app end to end with Node's test runner in `scripts/background-service.e2e.ts`. `apps/web/e2e` drives the served web client in Chromium with Playwright (`pnpm test:e2e`, its own CI job); each test starts a hub from source with an empty data folder under `.data/e2e`.
- Deterministic runtime: `HOBBOTS_RUNTIME=fake` selects the fake adapter in [`packages/runtimes/src/fake.ts`](../packages/runtimes/src/fake.ts) (see [`apps/server/src/config.ts`](../apps/server/src/config.ts)). A prompt that starts with `fake:cut-off` or `fake:limit` makes it end the reply early as a provider would, and `HOBBOTS_FAKE_AVAILABILITY` (`ready`, `outdated`, `signedOut`, `unavailable` or `unverified`) sets what its health check reports.
- CI: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `pnpm check` (SQLite) and, in a second job, the persistence and server suites with `HOBBOTS_TEST_DB=postgres` against a PostgreSQL service container.
- Test database: suites that need a database use `TestDatabase` from `@hobbots/persistence/testing` so both CI jobs exercise them; see [`packages/persistence/README.md`](../packages/persistence/README.md#test-database). `turbo.json` declares `HOBBOTS_TEST_DB` and `HOBBOTS_TEST_DATABASE_URL`, because Turborepo's strict env mode drops undeclared variables.
- Real interface: [README › Run from source](../README.md#run-from-source) starts the server and web client or the Electron app.

### Test case identity

Integration, end-to-end and regression tests carry a stable case ID at the start of the test title, for example `it("[TC-CH-001] streams a turn and resumes the session", …)`. The middle part is the requirement area (`CH`, `OR`, `IN`, …, or `GEN` when none fits). A comment names the requirement IDs the case covers (`// covers CH-001, CH-004`). Case IDs are separate from requirement IDs, are never reused, and a removed case is retired rather than renumbered. Pure unit tests do not need IDs. Existing tests get an ID when they are next changed.

## Environment and worktrees

- Requirements and run commands: [README › Run from source](../README.md#run-from-source). Server configuration and defaults: [`apps/server/src/config.ts`](../apps/server/src/config.ts). There is no `.env.example`; `.env*` files are git-ignored.
- The default data folder is the user's real Hobbots data (`~/Library/Application Support/Hobbots` on macOS, `~/.hobbots` elsewhere). For development and agent work, set `HOBBOTS_DATA_DIR` to a folder under the checkout such as `.data/` (git-ignored), and prefer `HOBBOTS_RUNTIME=fake` unless the task needs the real runtime.
- Worktrees are allowed, one branch per issue. Each worktree runs its own `pnpm install` and uses its own `HOBBOTS_DATA_DIR`. Parallel servers need distinct `HOBBOTS_PORT` values, with the web client pointed at them through `VITE_HOBBOTS_API_URL`. The web dev server uses fixed port 5173 (`strictPort` in [`apps/web/vite.config.ts`](../apps/web/vite.config.ts)), so only one web dev server runs at a time. Running several worktrees in parallel has not been verified.
- Cleanup: stop dev servers you started and delete the worktree's `.data/` folder with the worktree.
- `pnpm test:pg` runs the persistence and server suites on PostgreSQL from [`infrastructure/local`](../infrastructure/local/README.md); it needs Docker and port 54329. `infrastructure/docker` is a placeholder.

## Workflow

Matching development tasks use the installed [agent-engineering](https://github.com/otaviobarros/agent-engineering) skills by default. Task limits, AGENTS.md and the project's permissions still govern. A skill being selected never authorizes commits, push, PR comments, merge or deployment beyond what the task asked for.

| Requested outcome | Skill |
|---|---|
| Project setup or refresh of this guide | `setup-project` |
| Plan only | `plan-change` |
| Full implementation (issue → verified, reviewed draft PR) | `deliver-change` |
| Implement an accepted plan or slice only | `implement-change` |
| Verify only | `verify-change` |
| Analyze a change or branch | `review-change` |
| Review a GitHub PR | `review-pr` (report-only unless posting was asked for) |
| Correct review findings | `remediate-findings` |
| Authorized commit, push or draft PR | `publish-change` |

The plugin is registered for Claude Code in [`.claude/settings.json`](../.claude/settings.json). Codex users install it themselves; see [CONTRIBUTING.md](../CONTRIBUTING.md#coding-agents).

## Adoption record

Approach: **Adopt the recommended baseline** (selected by the maintainer during setup, 2026-10-28).
Workflow selection: **Default for matching tasks** (selected by the maintainer during setup, 2026-10-28).

| Practice | Disposition | Source or decision | Scope and rationale |
|---|---|---|---|
| Architectural constraints, contracts, ADR change control | Established | [AGENTS.md](../AGENTS.md), [ADR index](decisions/README.md) | Whole repository |
| `pnpm check` before handing work back or opening a PR | Established | [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md) | Root; the PR template checks it |
| Conventional Commits, `Closes #N`, issue forms and labels | Established | [Issues and the project board](contributing/issues-and-board.md) | All contributions |
| GitHub Issues as requirements owner for tasks; MVP requirement IDs | Established | [Issues and the project board](contributing/issues-and-board.md), [MVP requirements](product/mvp-requirements.md) | Resolve live issue state at task time |
| Deterministic fakes before real-runtime checks | Established | [AGENTS.md](../AGENTS.md) › Working rules | Runtime and orchestration work |
| Stable IDs for integration, E2E and regression tests | Established | agent-engineering workflow contract | Required by the adopted workflow |
| `[TC-<AREA>-NNN]` title prefix as the test ID scheme | Accepted | Setup interview | Fits Vitest titles with no tooling; IDs added as tests are touched |
| Catalog or duplicate-ID check for test cases | Proposed | No adoption decision | Add once enough tests carry IDs to need it; blocks nothing |
| Branch names `<type>/<issue>-<slug>` | Accepted | Setup interview; recorded in [Issues and the project board](contributing/issues-and-board.md#working-on-an-issue) | Matches Conventional Commit types |
| Worktree isolation (own install, data folder, port) | Accepted | Setup interview; [Environment and worktrees](#environment-and-worktrees) | Keeps agent work off real user data |
| Glossary | Accepted | [Glossary](product/glossary.md) | Built only from existing docs |
| Stable rule IDs for AGENTS.md constraints | Proposed | Deferred in setup interview | Revisit when reviews need to cite rules; blocks nothing |
| CI running `pnpm check` on SQLite and the persistence and server suites on PostgreSQL | Established | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [ADR 011](decisions/011-sqlite-storage.md) | Every pull request and push to `main` |
| Agent-engineering default routing | Accepted | Setup interview; [AGENTS.md](../AGENTS.md#workflow) | Guidance, not enforcement |

## Known gaps

- The background service of [ADR 012](decisions/012-macos-hub-service.md) is proven end to end only on packaged builds, by the release workflow's smoke test ([`apps/desktop/scripts/background-service.e2e.ts`](../apps/desktop/scripts/background-service.e2e.ts)); pull-request CI does not package the app. Opening at login after logging out and in stays a manual check on a real Mac.
- No `.env.example` or `CODEOWNERS`. Release Please proposes versions and creates the `v*` tags ([Releases](contributing/releases.md)); releases are built from those tags by [`.github/workflows/release.yml`](../.github/workflows/release.yml), described in the [desktop README](../apps/desktop/README.md).

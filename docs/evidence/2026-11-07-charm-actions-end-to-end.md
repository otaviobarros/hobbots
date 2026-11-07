# The hub action pipeline and the Charm registry, end to end, with a fake second Charm beside GitHub

- **Date:** 2026-11-07
- **Issue:** [#622](https://github.com/otaviobarros/hobbots/issues/622), the last task of [#614](https://github.com/otaviobarros/hobbots/issues/614)
- **Pull request:** opened from `claude/project-thread-fc0mxy`
- **Commit:** on top of `71ae780` on `main`, with a clean tree
- **Setup:** Linux x86_64 container, Node 22.23.4. The new suite runs a whole hub as the server composes it: the HTTP API, approvals, grants, the never-twice records, the GitHub Charm against a fake GitHub on a local port, Local Git with real Git, Memory over the in-memory store and Skills over the hub's library. Its turns ran on the hub's fake runtime, on an installed Claude Code 2.1.319 (`HOBBOTS_CLAUDE_CODE`) and on an installed Codex 0.167.0 from npm (`HOBBOTS_CODEX`), each with its stand-in model, so no account, real model or real GitHub was used. The persistence and server suites ran on SQLite through `node:sqlite` and on PostgreSQL 16 (the environment `pnpm test:pg` sets, on a local server instead of Docker).
- **Result:** Passed with gaps: a second Charm registered in the test alone is decided, asked, granted, recorded before it is sent, sent once, read back and redacted through the same pipeline as GitHub, on all three runtimes and both databases; taking it away stops the turn; Local Git, Memory and Skill calls record their steps first; and the tools a GitHub-granted hob sees are byte for byte the ones it saw before the slice. The manual run with real hobs against a real repository is not done yet.

## Checks

All in `apps/server/test/charm-actions-end-to-end.test.ts`, each case on the fake runtime, Claude Code and Codex in turn, on SQLite and on PostgreSQL. The Shelf Charm, with a read and a write that each name a shelf as their site, is declared and registered beside the GitHub Charm in that file alone.

| Case | Check | Result |
|---|---|---|
| `[TC-PE-514]` | Under Balanced a Shelf read asks, offers the shelf's `CharmSite` rule, and is sent only after you approve it; when the Charm sends it, its step is already recorded on the reply as running; the hob reads it opened with the outside-data line and with the token on the shelf redacted. Always answers the next read of that shelf without asking, and another shelf asks again | ✅ on all three runtimes |
| `[TC-PE-515]` | A Shelf write asks with its token redacted on the card; when the Charm sends it, its step and its keyed record (`sending`) are already stored, and the Charm gets the redacted note. The shelf does not answer, the hub reads it back and tells the hob the note took effect. The same key a second time in the turn is neither asked about nor sent again. Neither the steps, the card nor the stored call holds the token | ✅ on all three runtimes |
| `[TC-PE-516]` | Taking the Shelf Charm away while its write waits for you stops the turn (`interrupted`), the request no longer waits, nothing is sent, and the next turn is not offered the Charm | ✅ on all three runtimes |
| `[TC-PE-517]` | `git_init`, `memory_save` and `skill_propose` each have their step recorded before the hub runs them: the repository, the memory write and the proposal each exist only after their own step was recorded | ✅ on all three runtimes |
| `[TC-PE-518]` | Beside the Shelf Charm, a GitHub-granted hob reads its repository and searches without asking, pushes a branch, opens a draft pull request and comments, each after your approval, against the fake GitHub | ✅ on all three runtimes |
| `[TC-PE-519]` | The tools a GitHub-granted hob is offered, by name, description and input schema, equal `apps/server/test/fixtures/github-hob-tools.json`: `git_init`, the six `github_*` tools, the two Memory tools and the four Skill tools. The fixture was written from this hub and compared with the same list from the hub at `8b507dc`, the commit before the slice's first code change: the two are identical, byte for byte | ✅ |
| GitHub Charm case IDs of #614 | Of the 171 IDs in the ranges #614 lists, 124 are carried by tests, before the slice and after it alike; the other 47 were never assigned. The 118 in Vitest suites passed (`packages/agents`, `charms`, `inbox`, `permissions`, `runtimes`, `workbench`, `persistence`, `apps/web` unit tests and `apps/server`), the 51 of them in the persistence and server suites on SQLite and on PostgreSQL. The other 6 are in the browser suites, which did not run here (see Gaps) | ✅ |
| No regressions | Every suite #614 lists under "No regressions": the server's GitHub Charm, hob app and identity, approvals, permissions, skill proposals and memory suites, and `packages/charms`, `memory`, `permissions`, `agents` and `runtimes`, on SQLite and PostgreSQL, with the installed-runtime suites (`[TC-PE-471]`, `[TC-PE-472]`, `[TC-PE-495]`, `[TC-PE-496]`) on Claude Code and Codex | ✅ |

## How the runtimes were driven

The hub's runtime in the suite is the fake runtime, wrapped so that, for Claude Code and Codex, the request the hub built (its hub tools, its step recorder and its approvals) is handed to the installed runtime through `hubCallRuntimes` in `@hobbots/runtimes/testing`, whose stand-in model makes the turn's scripted calls. The hub records, asks and answers every call itself, as it does for any runtime, and the steps were recorded under each runtime's own call ids (`toolu_…` on Claude Code, `call-…` on Codex). `hubCallRuntimes` gained `events` for this; its `turn` is unchanged.

## Gaps

- The GitHub Charm was not run by hand with real models on Claude Code and Codex hobs against a real test repository, on macOS or the packaged app ([#622](https://github.com/otaviobarros/hobbots/issues/622)). Everything above ran on stand-in models and a fake GitHub.
- `[TC-DP-008]` fails in this container on SQLite and PostgreSQL, as recorded for #620: it has no IPv6, so `::1` cannot be reached. It touches no hub tool.
- Turbo could not start its tasks in this container (`Exec format error`), so each step of `pnpm check` ran on its own: the standards, layer, complexity, frontend, script, knip, jscpd and Biome checks, and each package's typecheck and tests. All passed but `[TC-DP-008]`.
- The browser suites #614 lists did not run in this container: its Chromium (build 1243) is older than the one this Playwright expects (1248), and with it no page showed the composer, in these suites or any other. So `[TC-IN-132]`, `[TC-IN-150]`, `[TC-IN-152]`, `[TC-IN-153]`, `[TC-IN-154]` and `[TC-OR-075]`, and `apps/web/e2e/github-charm.e2e.ts`, `charm-calls.e2e.ts`, `hob-github-app.e2e.ts`, `approvals*.e2e.ts`, `task-approvals.e2e.ts`, `party-approvals.e2e.ts`, `hob-profile.e2e.ts` and `skill-proposals.e2e.ts`, are left to CI. This change touches no web or server source.
- Docker was not available, so the PostgreSQL run used a local PostgreSQL 16 server on the port `pnpm test:pg` uses.

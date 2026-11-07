# Push steering as a declaration of the GitHub Charm

- **Date:** 2026-11-07
- **Issue:** [#621](https://github.com/otaviobarros/hobbots/issues/621)
- **Pull request:** opened from `claude/project-thread-6avcvu`
- **Commit:** on top of `ada48244f6094002f44e1b9ae2c8715aff10ac1e`, with a clean tree
- **Setup:** Linux x86_64 container, Node 22.23.4. The suites ran with fake Charms, the real GitHub Charm against a fake GitHub, the Claude Code policy hook, Codex's App Server protocol against a fake server, the fake runtime and the real policy engine; the server suites ran on SQLite. No account, real model, installed runtime or real GitHub was used. The change touches no SQL, migration or repository, so the PostgreSQL suites were not run.
- **Result:** Passed with gaps: `HubTools` has only `tools` and `call`, the GitHub Charm declares the Push it steers, and `approval.ts` decides that steering for Claude Code, Codex and the fake runtime from the declaration alone. A `git push` from a hob with the GitHub Charm is steered as before.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-512]` | The registry exposes the takeovers of the Charms a hob holds and that are connected, the offer a runtime gets carries the same ones, and a takeover the Charm does not declare, a second of one request or one to a tool it does not offer stops the hub | ✅ |
| `[TC-PE-513]` | A fake Charm's declaration steers a `git push` to its tool on Claude Code, Codex and the fake runtime, in the folders it applies to only; elsewhere, and without the Charm, the push is decided as Push | ✅ |
| `[TC-PE-158]` | The GitHub Charm's steering: a `git push` in a folder whose origin is on GitHub is refused with the pointer to `github_push` in every preset, and a folder without a GitHub origin, or one the hob was not given, keeps its push decided as Push | ✅ Same assertions |
| `[TC-OR-742-02]` | A commit the hub holds for a lead is refused with whose work it is, on every runtime, now from the turn's steering | ✅ Same assertions |
| Runtime, Charm and server suites | `packages/runtimes/test`, `packages/charms/test`, `packages/agents/test`, `packages/orchestration/test` and `apps/server/test`, including the GitHub Charm, Push, Git push, hob identity and member `git_init` suites | ✅ Without a loosened assertion |

## Behaviour that changes on purpose (ADR 031)

None that a hob or the user sees. The steering moved from `HubTools` to the turn's `steering`, so the tests that hand a runtime a hand-made steering now build it in the new shape: `[TC-PE-158]` in `policy-hooks.test.ts`, `[TC-OR-742-02]` in `commit-contract.test.ts`, the `git_init` steering tests in `sandbox-git-init.test.ts`, and the GitHub Charm's `[TC-PE-158]`, which reads the Charm's takeover from the registry. Their assertions are unchanged. The refusal's words now take the Charm's name from its declaration, and read the same for GitHub.

## Gaps

- `[TC-DP-008]` fails in this container on SQLite, before and after this change: it has no IPv6, so `::1` cannot be reached.
- macOS, the packaged app, installed runtimes and the browser e2e suites were not run. The end-to-end proof of the slice is [#622](https://github.com/otaviobarros/hobbots/issues/622).

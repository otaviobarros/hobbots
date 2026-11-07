# Push runs through the hub action pipeline

- **Date:** 2026-11-07
- **Issue:** [#619](https://github.com/otaviobarros/hobbots/issues/619)
- **Pull request:** opened from `claude/project-thread-wj3w1l`
- **Commit:** the branch's head, with a clean tree
- **Setup:** Linux x86_64 container, Node 22.23.4. The Push suites pushed for real with Git to the fake GitHub, with the fake runtime, the real policy engine and in-memory call records; the persistence and server suites ran on SQLite and on PostgreSQL 16 (the same environment `pnpm test:pg` sets, on a local server instead of Docker). No account, real model or real GitHub was used.
- **Result:** Passed: `github_push` runs through the pipeline with the same tool name, input schema, card and digest as before; its input is planned, shown and stored redacted; its step is recorded before anything reaches GitHub, and nothing is pushed or stored when it cannot be; the branch it stages is held until the call ends.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-497]` | The card and digest of the same push, pinned from the code before the move | ✅ Identical |
| `[TC-PE-498]` | A secret in the push's branch is not in the card, the step, the stored call or the answer, and nothing is pushed | ✅ Fails before this change |
| `[TC-PE-499]` | The step is recorded before GitHub is reached and before the keyed record; an unrecorded step pushes and stores nothing | ✅ Fails before this change |
| Push and GitHub suites | `github-push`, `git-push`, `github-writes`, `github-charm`, `hob-app`, the rest of `packages/charms/test`, and the server's GitHub Charm, hob app and hob identity end-to-end suites | ✅ Without a loosened assertion |

The `github_push` input schema the hob is offered was compared, byte for byte, with the one the code before the move produced, and the GitHub Charm still offers its tools in the same order.

## Behaviour that changes on purpose (ADR 031)

- The push's input is redacted before it is planned, as every Charm write's is, so a branch or folder name that looks like a secret is planned redacted and refused, never pushed under its real name.
- A retried key answers before the push is planned, so a repeated call no longer checks its branch names or folder again before it answers as it did.
- A push refused by the policy or by you now ends its step as refused, as the other writes do.

## Gaps

- `[TC-OR-458]` timed out once at 5 s in the full PostgreSQL server run. Run alone it fails about one time in four here, on `main` too, so it is flaky in this container and touches no hub tool.
- `[TC-DP-008]` fails in this container on SQLite and PostgreSQL, before and after this change: it has no IPv6, so `::1` cannot be reached.
- macOS, the packaged app and the browser e2e suites were not run.
- Turbo could not start its tasks in this container (`Exec format error`), so each step of `pnpm check` ran on its own: the standards, layer, complexity, frontend, script, knip, jscpd and Biome checks, each package's typecheck, and each package's tests.
- Docker was not available, so the PostgreSQL run used a local PostgreSQL 16 server on the port `pnpm test:pg` uses.
- The pipeline runs the same on every runtime, and each runtime's step recording is checked by `[TC-PE-470]` to `[TC-PE-473]` (#617); no installed Claude Code or Codex ran in this change.

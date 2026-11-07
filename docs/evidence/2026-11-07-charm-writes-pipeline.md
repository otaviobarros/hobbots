# Opening pull requests, commenting and `git_init` run through the hub action pipeline

- **Date:** 2026-11-07
- **Issue:** [#618](https://github.com/otaviobarros/hobbots/issues/618)
- **Pull request:** opened from `claude/project-thread-fo442e`
- **Commit:** the branch's head, with a clean tree
- **Setup:** Linux x86_64 container, Node 26.13.0. The pipeline, GitHub write and Local Git suites ran with the fake runtime, the real policy engine and in-memory call records; the persistence and server suites ran on SQLite and on PostgreSQL (`pnpm test:pg`). No account, real model or real GitHub was used.
- **Result:** Passed: `github_open_pull_request`, `github_comment` and `git_init` run through the pipeline with the same tool names, input schemas, cards and digests as before; every Charm write carries a key the pipeline adds, is sent once, is read back after an uncertain end or waits for the user, and is stored redacted with its Charm and its applied text as their own values; each call records its step before anything is sent.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-480]` | The card and digest of the same pull request and comment, pinned from the code before the move | ✅ Identical |
| `[TC-PE-481]` | A fake Charm write is offered with a required `key`, refused without one, and planned without it | ✅ |
| `[TC-PE-482]` | The same key twice sends once and answers as the first call ended, without asking again | ✅ |
| `[TC-PE-483]` | An uncertain write whose read-back finds the change answers as applied | ✅ |
| `[TC-PE-484]` | An uncertain write without a read-back waits until the user settles it, in the Charm's words | ✅ |
| `[TC-PE-485]` | A write's input is planned, shown and stored redacted, and the plan is told which fields were | ✅ |
| `[TC-PE-486]` | The step is recorded before the never-twice record; an unrecorded step records and sends nothing | ✅ |
| `[TC-PE-487]` | `git_init` records its step before it creates anything, and creates nothing unrecorded | ✅ |
| `[TC-PE-488]` | Opening a pull request and commenting send nothing when their step cannot be recorded | ✅ |
| `[TC-DP-289]` | Migration 0074 names each stored call's Charm and moves its applied text out of its plan | ✅ On SQLite and PostgreSQL |
| GitHub and Local Git suites | `github-writes`, `github-api-writes`, `github-push`, `github-charm`, `hob-app`, `local-git`, the moved `charm-calls` suite, and the server's GitHub Charm and Local Git end-to-end suites | ✅ Without a loosened assertion |

The tool list the GitHub Charm and Local Git offer was compared, byte for byte, with the one the code before the move produced.

## Gaps

- macOS, the packaged app and the browser e2e suites were not run.
- `[TC-DP-008]` fails in this container on SQLite and PostgreSQL, before and after this change: it has no IPv6, so `::1` cannot be reached.
- Turbo could not start its tasks in this container (`Exec format error`), so each step of `pnpm check` ran on its own: the standards, layer, complexity, frontend, script, knip, jscpd and Biome checks, each package's typecheck, and each package's tests.
- The pipeline runs the same on every runtime, and each runtime's step recording is checked by `[TC-PE-470]` to `[TC-PE-473]` (#617); no installed Claude Code or Codex ran in this change.

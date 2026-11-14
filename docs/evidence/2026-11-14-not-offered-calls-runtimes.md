# A call to a tool the session was not offered is recorded as a refusal, on Claude Code, Codex and the fake runtime

- **Date:** 2026-11-14
- **Issue:** [#1356](https://github.com/otaviobarros/hobbots/issues/1356)
- **Pull request:** [#1522](https://github.com/otaviobarros/hobbots/pull/1522)
- **Commit:** the pull request branch `claude/project-thread-bt5smb`, after `b82e431`
- **Setup:** a Linux x86_64 cloud container, from a source checkout, Node 22.23.4. Claude Code 2.1.325, codex-cli 0.169.0 and 0.166.0, installed and not signed in, each answered by a stand-in model: Claude Code through the Messages stand-in, Codex through the Responses stand-in. The fake runtime in the same run. SQLite, and PostgreSQL 16.
- **Result:** Passed with gaps: each installed runtime refused the call itself and Hobbots reported it as a refused step marked not offered, on a new and a resumed Codex thread too, and the hub recorded it on the member's Task with the reason its offer gives, which its lead's `read_tasks` showed. Nothing was run with a real model.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-1356-01]` | `HOBBOTS_CLAUDE_CODE=<claude> npx vitest run test/clean-runtime-claude-code.test.ts -t 1356` in `packages/runtimes`: the model calls a hub tool, a prefixed hub tool and Bash, none of them offered | ✅ Claude Code 2.1.325 answered each with "No such tool available"; each was reported as a `ToolDenied` marked not offered, Bash naming commands, and none reached the hub |
| `[TC-PE-1356-02]` | `HOBBOTS_CODEX=<codex> npx vitest run test/clean-runtime-codex.test.ts -t 1356` in `packages/runtimes`, once per Codex version: a new thread, then the same thread resumed | ✅ 0.169.0 and 0.166.0: Codex answered "unsupported call", which Hobbots read from the thread's rollout and reported as refused, not offered, on both threads |
| `[TC-OR-1356-01]` | `HOBBOTS_CLAUDE_CODE=<claude> HOBBOTS_CODEX=<codex 0.169.0> npx vitest run test/member-github-writes.test.ts -t 1356` in `apps/server`, on SQLite and with `HOBBOTS_TEST_DB=postgres`: Rook holds no GitHub Charm and calls `github_comment` | ✅ fake, Claude Code and Codex, on both databases: refused on Rook's Task with "It is not offered because Rook does not hold the GitHub Charm.", no request reached GitHub, and the lead's `read_tasks` listed it under `refused_calls` |
| `[TC-OR-1356-02]`, `[TC-OR-1356-03]` | The same run, on the fake runtime: a lead's chat call to a tool its turn lacks; a member's command where its runtime cannot start its sandbox | ✅ a denied step recorded on the Task; the refusal names "Rook's runtime cannot start its sandbox on this hub" |
| `[TC-PE-1356-03]` to `[TC-PE-1356-08]` | Unit tests: Claude Code message reading, the fake runtime, the Codex rollout reader (reads that overlap included), the reason words | ✅ |

## Gaps

- The stand-in model makes the calls each prompt scripts.
- Not run with a signed-in runtime and a real model, nor on the packaged app.

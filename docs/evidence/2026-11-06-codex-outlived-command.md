# A Codex command that outlives its turn ends with its real exit code, and the hob is told

- **Date:** 2026-11-06
- **Issue:** [#1048](https://github.com/otaviobarros/hobbots/issues/1048)
- **Pull request:** [#1053](https://github.com/otaviobarros/hobbots/pull/1053)
- **Commit:** `e8eb081` on the pull request's branch, not yet on `main`
- **Setup:** Linux x86_64 container, Node 22. Codex 0.166.0 (the native `codex` binary of `@openai/codex@0.166.0-linux-x64` from npm), started by the adapter's turn runner as `codex app-server` with a hob's own `CODEX_HOME` and the hob's policy, without Hobbots' sandbox. No account: a scripted stand-in for the Responses API played the model. Run with `HOBBOTS_CODEX=<codex> pnpm --filter @hobbots/runtimes exec vitest run test/codex-live.test.ts`.
- **Result:** Passed with gaps. Codex kept the command running after its call returned and after the turn completed, and reported its end; the adapter waited for it, recorded its real exit code and told the hob in a follow-up turn. A real model and the packaged Mac app are not verified.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-RT-1048-03]` | The stand-in runs `sleep 3; echo slept; exit 3` with `exec_command` and `yield_time_ms: 500`; Codex answers the call with "Process running with session ID" and the stand-in replies "Done." | ✅ |
| `[TC-RT-1048-03]` | The turn completes while the command runs; the adapter keeps the App Server, and the command's end is recorded as failed with exit code 3 and the output `slept` | ✅ |
| `[TC-RT-1048-03]` | A follow-up turn's request holds the `<commands-ended>` notice naming the command and "exited with code 3", and the reply reads "Done." then the follow-up's answer | ✅ |
| `[TC-RT-030]` | Cancelling mid-turn is still acknowledged inside the grace period | ✅ |
| `[TC-RT-1048-01]`, `[TC-RT-1048-02]` | With a scripted App Server in CI: the follow-up turn and its notice, and no follow-up when the command ends inside its turn | ✅ |

## Gaps

- A real model (`gpt-6-luna` in code mode) and the packaged Mac app with Codex inside Hobbots' sandbox: [#1048](https://github.com/otaviobarros/hobbots/issues/1048)'s `sleep 15` should be run there again.
- A command left running on purpose, such as a dev server, holds the reply open until it ends or the user stops it; whether that wait needs a limit is open.

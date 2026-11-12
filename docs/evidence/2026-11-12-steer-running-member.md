# A lead's message reaches its member's running turn on Claude Code, Codex and the fake runtime

- **Date:** 2026-11-12
- **Issue:** [#1345](https://github.com/otaviobarros/hobbots/issues/1345)
- **Pull request:** [#1437](https://github.com/otaviobarros/hobbots/pull/1437)
- **Commit:** the pull request branch `claude/project-thread-whzhp3`, after `0d056dc`
- **Setup:** a Linux x86_64 cloud container, from a source checkout, Node 22.23.4. Claude Code 2.1.323 and codex-cli 0.166.0 and 0.167.0, installed and not signed in, each answered by a stand-in model through the hub's hub-tool bridge. The fake runtime in the same run. SQLite, and PostgreSQL 16 for the persistence suite and the hub tests.
- **Result:** Passed with gaps: on each runtime a message that arrived during one hub call reached the model before its next call, and at hub level a steered message reached the member in the same turn, an interrupting one restarted it, a late one went to the next turn and a turn waiting on your approval kept its card. Nothing was run with a real model.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-RT-1345-01]` | `HOBBOTS_CLAUDE_CODE=<claude> HOBBOTS_CODEX=<codex> npx vitest run test/turn-steers.test.ts` in `packages/runtimes`, once per Codex version: a turn calls `list_files` then `write_report`, and a message arrives during the first call | ✅ fake, Claude Code 2.1.323, Codex 0.166.0 and 0.167.0: the first model request that carries the message carries the first call's answer and not the second's |
| `[TC-OR-1345-01]` to `[TC-OR-1345-04]` | Hub tests in `apps/server` with the fake runtime: steer between two tool calls, interrupt and restart, a late steer to the next turn, the approval card kept | ✅ on SQLite and PostgreSQL |
| `[TC-OR-1345-05]`, `[TC-OR-1345-06]` | `message_task` tells the lead a message steers by default, and that a runtime without `steersTurns` is interrupted instead | ✅ on SQLite and PostgreSQL |
| `[TC-IN-1345-01]` to `[TC-IN-1345-04]` | The dispatcher hands an item to a running turn and settles it once the runtime took it, sends it back when it did not or the hand-off was interrupted, hands nothing another turn holds or that is late, and keeps the claim while the runtime takes twice the lease to answer, so the item is never delivered twice | ✅ on SQLite and PostgreSQL |

## Gaps

- Not run with a signed-in runtime and a real model, nor on the packaged app.
- No browser test shows a steered message's receipt; the hub tests check the note's pick-up that the receipt reads.

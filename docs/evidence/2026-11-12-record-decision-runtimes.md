# record_decision records a decision on Claude Code, Codex and the fake runtime

- **Date:** 2026-11-12
- **Issue:** [#1383](https://github.com/otaviobarros/hobbots/issues/1383)
- **Pull request:** [#1415](https://github.com/otaviobarros/hobbots/pull/1415)
- **Commit:** the pull request branch `claude/project-thread-uiorfm`, after `056a54a`
- **Setup:** a Linux x86_64 cloud container, from a source checkout, Node 22.23.4. Claude Code 2.1.322 and codex-cli 0.167.0, installed and not signed in, each answered by a stand-in model through the hub's hub-tool bridge. The fake runtime in the same run. SQLite, and PostgreSQL 16 for the records suite.
- **Result:** Passed with gaps: on each runtime a turn's `record_decision` call recorded the decision as the hob, from its reply, and a call over 500 characters was refused with nothing recorded. The context pack does not read the records yet, and nothing was run with a real model.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-CH-1383-07]` | `HOBBOTS_CLAUDE_CODE=<claude> HOBBOTS_CODEX=<codex> npx vitest run test/record-decision-runtimes.test.ts` in `apps/server`: each runtime makes two `record_decision` calls, one valid and one of 501 characters | ✅ fake, Claude Code and Codex: the first recorded by the hob from its reply, the second refused as `too-long` |
| `[TC-CH-1383-08]` | A chat turn on the fake runtime records a decision; the API lists it, records yours, crosses one out and refuses one in a closed camp | ✅ |
| `[TC-CH-1383-01]` to `[TC-CH-1383-06]`, `[TC-CH-1383-09]`, `[TC-CH-1383-10]` | The records suite in `packages/persistence` on SQLite and PostgreSQL: replacing, retrying, crossing out, thread-scoped keys, artifacts once at their latest version, records moved with a chapter, message authors and the migration | ✅ on both |

## Gaps

- The context pack does not carry active decisions and the artifacts index into a turn yet ([#1380](https://github.com/otaviobarros/hobbots/issues/1380), [#1383](https://github.com/otaviobarros/hobbots/issues/1383)).
- Replacing a decision is proven through the hub and the fake runtime, not through a call on installed Claude Code or Codex.
- Not run with a signed-in runtime and a real model, nor on the packaged app.
- The camp sheet that shows decisions and artifacts is not built ([#1387](https://github.com/otaviobarros/hobbots/issues/1387)).

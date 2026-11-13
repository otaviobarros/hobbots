# A Quest's acceptance criteria hold on Claude Code, Codex and the fake runtime

- **Date:** 2026-11-13
- **Issue:** [#1445](https://github.com/otaviobarros/hobbots/issues/1445)
- **Pull request:** [#1509](https://github.com/otaviobarros/hobbots/pull/1509)
- **Commit:** the pull request branch `claude/project-thread-8pn8kn`, after `597f94c`
- **Setup:** a Linux x86_64 cloud container, from a source checkout, Node 22.23.4. Claude Code 2.1.325 and codex-cli 0.169.0, installed and not signed in, each answered by a stand-in model through the hub's hub-tool bridge: Claude Code through its MCP server, Codex through its dynamic tools. The fake runtime in the same run. SQLite, and PostgreSQL 16.
- **Result:** Passed with gaps: on each runtime, every turn of the lead and its members ran on that runtime, and the hub held the Quest open until a required criterion was accepted on evidence, voided that evidence when a newer version of the page arrived, turned the lead's waiver into a question to you, and waived it only by your "Waive it", in your name. Nothing was run with a real model.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OR-1445-08]` | `HOBBOTS_CLAUDE_CODE=<claude> HOBBOTS_CODEX=<codex> npx vitest run test/quest-criteria-runtimes.test.ts` in `apps/server`, on SQLite and with `HOBBOTS_TEST_DB=postgres`: the lead starts a Quest with one required criterion and one optional one given as an object, Pip returns the page, the lead's early completion is refused, it accepts the date on Pip's page and waives the photo, Quill returns the page again, the lead's next completion is refused as voided, its waiver of the date asks you, and your "Waive it" completes the Quest | ✅ fake, Claude Code and Codex, on both databases: each runtime's model read the hub's answers, the criterion waived by you with its evidence on version 1 voided, the optional one waived by the hob |
| `[TC-OR-1445-04]` to `[TC-OR-1445-06]` | The same rules at hub level, with the fake runtime as Claude Code and Codex | ✅ |
| `[TC-UX-1445-07]` | The quest's sheet in the browser, on the fake runtime | ✅ |

## Gaps

- The stand-in model makes the calls each prompt scripts. A reference to an earlier answer, such as `$pip-done.artifacts.0`, is resolved by the test as the hub is called, since the stand-in is handed every call before the turn starts.
- Not run with a signed-in runtime and a real model, nor on the packaged app.

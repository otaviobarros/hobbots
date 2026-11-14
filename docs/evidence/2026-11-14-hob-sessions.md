# Each hob in a thread resumes its own runtime session, on every runtime

- **Date:** 2026-11-14
- **Issue:** [#1464](https://github.com/otaviobarros/hobbots/issues/1464)
- **Pull request:** [#1520](https://github.com/otaviobarros/hobbots/pull/1520)
- **Commit:** `8139c39` on the pull request branch `claude/project-thread-a8wo6n`, after merging `main`
- **Setup:** a Linux x86_64 cloud container, from a source checkout, Node 22.23.4. Claude Code 2.1.325, and codex-cli 0.167.0 and 0.169.0, installed and not signed in, each answered by a stand-in model: Claude Code through a Messages API stand-in, Codex through a Responses API stand-in. The fake runtime in the same run. SQLite, and PostgreSQL 16.
- **Result:** Passed with gaps: two hobs' sessions in one workspace each resumed only their own history on Claude Code, Codex and the fake runtime, and in the hub each hob in a thread resumed only its own session while a hob new to the live chapter started one from the pack. Nothing was run with a real model.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-RT-1464-01]` | `HOBBOTS_CLAUDE_CODE=<claude> npx vitest run test/clean-runtime-claude-code.test.ts -t 1464` in `packages/runtimes`: Wren's and Quill's sessions start in one workspace, each with its own marker, then each is resumed by its id | ✅ each resumed session's requests to the model held its own marker and never the other's |
| `[TC-RT-1464-02]` | `HOBBOTS_CODEX=<codex> npx vitest run test/clean-runtime-codex.test.ts -t 1464` in `packages/runtimes`, on Codex 0.167.0 and 0.169.0: the same two sessions on Codex | ✅ on both versions |
| `[TC-RT-1464-03]` | The same on the fake runtime: each resumed session keeps the instructions it started with | ✅ |
| `[TC-CH-1464-01]` | `npx vitest run test/hob-sessions.test.ts` in `apps/server`, on SQLite and with `HOBBOTS_TEST_DB=postgres`: in Wren's thread, Wren speaks, then Quill, then Wren again, with the fake runtime as Claude Code and as Codex | ✅ Quill's first turn started a new session from the pack, its next resumed Quill's, and Wren's resumed Wren's untouched session |
| `[TC-DP-1464-01]` | `npx vitest run test/hob-sessions.test.ts` in `packages/persistence`, on SQLite and PostgreSQL: migration `20261114005209_hob_sessions` on stored threads and journaled `ThreadUpserted`, `CampMade` and `ChatStartedFresh` | ✅ every session took its thread's hob, every entry decoded at its new version, and a second run changed nothing |

## Gaps

- The stand-in models answer what each prompt scripts. Not run with a signed-in runtime and a real model, nor on the packaged app.
- Nothing in the hub lets a second hob answer in a thread yet, so `[TC-CH-1464-01]` hands the thread to the other hob in the database. Who answers comes with [#1460](https://github.com/otaviobarros/hobbots/issues/1460) and [#1461](https://github.com/otaviobarros/hobbots/issues/1461).
- The pack that names every speaker and carries only what was said since a hob last spoke is [#1465](https://github.com/otaviobarros/hobbots/issues/1465).

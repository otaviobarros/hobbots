# Memory and Skill tools run through the hub action pipeline

- **Date:** 2026-11-07
- **Issue:** [#1135](https://github.com/otaviobarros/hobbots/issues/1135)
- **Pull request:** to be opened from `claude/project-thread-iikuyt`
- **Commit:** the branch head, with a clean tree
- **Setup:** Linux x86_64 container, Node 22.23.4, SQLite through `node:sqlite`. The Memory and Skills suites ran with the in-memory memory store, the real policy engine and, through the hub, the fake runtime. The clean-runtime contract suites ran against an installed Claude Code 2.1.319 (`HOBBOTS_CLAUDE_CODE`) and an installed Codex 0.167.0 from npm (`HOBBOTS_CODEX`), each with its stand-in model, so no account or real model was used.
- **Result:** Passed: every Memory and Skill call is decided, asked and recorded by the pipeline before memory or the library is reached, and nothing is reached when its step cannot be recorded; the tools keep their names, inputs, answers and cards; and Claude Code, Codex and the fake runtime each hand a hub call a step that records it with the turn's `recordToolStart`.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-490]` | A built-in set on the pipeline: offered by its operations' answers, none offered under Never or without access, an unoffered tool still decided when called | ✅ |
| `[TC-PE-491]` | A call that changes nothing, a set's own decode wording, and a set's own refused answer after an approval | ✅ Answered unrecorded and undecided; the approval note follows the refusal, as before |
| `[TC-PE-492]` | `memory_save` and `memory_search` with a step that records, and one that cannot | ✅ Recorded before memory is written or searched; nothing reached and no save recorded when the step cannot be recorded |
| `[TC-PE-493]` | The four Skill tools with a step that records, and one that cannot | ✅ The request is recorded before the skill is assigned; nothing assigned, noted or proposed when the step cannot be recorded |
| `[TC-PE-494]` | Through the hub with the fake runtime: a save then a search in one reply | ✅ Each call's step is saved with the reply, `running` and stamped, when memory is reached |
| `[TC-PE-470]` to `[TC-PE-472]` | The step-recording contract on the fake runtime, an installed Claude Code 2.1.319 and an installed Codex 0.167.0 | ✅ |
| The Memory and Skills suites | `packages/memory/test/*`, the memory suites in `apps/server/test` and `apps/server/test/skill-proposals.test.ts`, a repeated key included (`[TC-GEN-245]`, `[TC-AG-147]`) | ✅ Unchanged but for `[TC-AG-156]`, whose note call now carries a step, since a call without one is no longer sent (ADR 031) |

## Gaps

- macOS and the packaged app were not run.
- No real model ran; the installed-runtime cases ran with stand-in models and run only where the binaries are set, so CI does not repeat them.

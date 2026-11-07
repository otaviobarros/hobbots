# Memory and Skill tools run through the hub action pipeline

- **Date:** 2026-11-07
- **Issue:** [#1135](https://github.com/otaviobarros/hobbots/issues/1135)
- **Pull request:** [#1176](https://github.com/otaviobarros/hobbots/pull/1176)
- **Commit:** `e569305` on `claude/project-thread-iikuyt`, with a clean tree
- **Setup:** Linux x86_64 container, Node 22.23.4, SQLite through `node:sqlite`. The Memory and Skills suites ran with the in-memory memory store and the real policy engine. The suites that run each set on every runtime, and the clean-runtime contract suites, ran on the fake runtime and against an installed Claude Code 2.1.319 (`HOBBOTS_CLAUDE_CODE`) and an installed Codex 0.167.0 from npm (`HOBBOTS_CODEX`), each with its stand-in model, so no account or real model was used.
- **Result:** Passed: every Memory and Skill call is decided, asked and recorded by the pipeline before it is sent, so before memory is searched or written and before the skills library changes, and nothing is sent when its step cannot be recorded; the tools keep their names, inputs, answers and cards; and each set does so on Claude Code, Codex and the fake runtime. Planning a skill call still reads the library to find the skill it names, and a request for a skill the hob already has is answered without being decided or recorded, as before.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-490]` | A built-in set on the pipeline: offered by its operations' answers, none offered under Never or without access, an unoffered tool still decided when called | ✅ |
| `[TC-PE-491]` | A call that changes nothing, a set's own decode wording, and a set's own refused answer after an approval | ✅ Answered unrecorded and undecided; the approval note follows the refusal, as before |
| `[TC-PE-492]` | `memory_save` and `memory_search` with a step that records, and one that cannot | ✅ Recorded before memory is written or searched; nothing reached and no save recorded when the step cannot be recorded |
| `[TC-PE-493]` | The four Skill tools with a step that records, and one that cannot | ✅ The request is recorded before the skill is assigned; nothing assigned, noted or proposed when the step cannot be recorded |
| `[TC-PE-494]` | Through the hub with the fake runtime: a save then a search in one reply | ✅ Each call's step is saved with the reply, `running` and stamped, when memory is reached |
| `[TC-PE-495]` | The Memory tools on the fake runtime, Claude Code 2.1.319 and Codex 0.167.0: a save then a search, recorded and unrecorded | ✅ On each, recorded before memory is written or searched; nothing reached and no save recorded when the turn refuses to record |
| `[TC-PE-496]` | The four Skill tools on the fake runtime, Claude Code 2.1.319 and Codex 0.167.0, recorded and unrecorded | ✅ On each, the request is recorded before the skill is assigned; nothing assigned or proposed when the turn refuses to record |
| `[TC-PE-470]` to `[TC-PE-472]` | The step-recording contract on the fake runtime, an installed Claude Code 2.1.319 and an installed Codex 0.167.0 | ✅ |
| The Memory and Skills suites | `packages/memory/test/*`, the memory suites in `apps/server/test` and `apps/server/test/skill-proposals.test.ts`, a repeated key included (`[TC-GEN-245]`, `[TC-AG-147]`) | ✅ Unchanged but for `[TC-AG-156]`, whose note call now carries a step, since a call without one is no longer sent (ADR 031) |

## Gaps

- macOS and the packaged app were not run.
- No real model ran; the installed-runtime cases ran with stand-in models and run only where the binaries are set, so CI does not repeat them.

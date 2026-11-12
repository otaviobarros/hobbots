# A long chat's turns start from the context pack, with fewer tokens

- **Date:** 2026-11-12
- **Issue:** [#1380](https://github.com/otaviobarros/hobbots/issues/1380)
- **Pull request:** [#1416](https://github.com/otaviobarros/hobbots/pull/1416)
- **Commit:** `032df94` for the token numbers, which later commits on the pull request do not change; `[TC-CH-1380-09]` and `[TC-CH-1380-13]` were added after review, on the pull request's next commit
- **Setup:** Linux, from a source checkout with `pnpm install --frozen-lockfile`. A scripted chat of 200 messages in 4 topics of 50 messages each, from 400 to 1,300 characters a message. Tokens are estimated as 4 characters a token, the estimate the pack's budget uses. The hub cases run on the fake Claude Code and Codex runtimes, on SQLite.
- **Result:** Passed with gaps. On the last topic, every turn starts with fewer tokens than before, and the 25 turns together cost about 86% less. Real models and the Focus chip were not part of this run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-CH-1380-08]` | `npx vitest run test/context-pack-tokens.test.ts` in `packages/agents`: the tokens each of the last topic's 25 turns starts with, before (one session resumed across the whole thread, so the whole transcript so far) and after (the pack, with the three earlier chapters' plain summaries, plus the live chapter so far) | ✅ First turn 32,423 → 155 tokens; last turn 42,860 → 10,592; all 25 turns 941,375 → 134,675 (−86%) |
| `[TC-CH-1380-01]` to `[TC-CH-1380-07]` | `npx vitest run test/context-pack.test.ts` in `packages/agents`: the same records give the same pack (snapshot), it never goes over its budget, active decisions and open work are never dropped silently, a last turn larger than the budget is cut with a pointer for `read_message`, and the `PackReport` marks every trim | ✅ |
| `[TC-CH-1380-09]` | The same file: a part whose share is zero keeps none of its text, and on random records any split of the same total keeps the pack within it | ✅ |
| `[TC-CH-1380-10]` | `npx vitest run test/context-pack.test.ts` in `apps/server`, on the fake Claude Code and Codex runtimes: a new chapter's first session gets the open Task with its last step, its question, the active decision and the previous chapter's summary from the pack, and nothing of the old transcript | ✅ both runtimes |
| `[TC-CH-1380-11]` | The same file: the chapter summary projector writes each resting chapter's summary once, and a projector sent back to the start of the journal writes nothing twice | ✅ |
| `[TC-CH-1380-12]` | The same file: a private camp's chapter summary reaches the camp's next session, memory capture takes nothing of it, and another chat's pack never reads it | ✅ |
| `[TC-CH-1380-13]` | `npx vitest run test/context-pack.test.ts` in `apps/server`: a summary the brain wrote while a split changed its chapter is not kept, and the next round summarizes both chapters from what they now hold | ✅ |

## Gaps

- Tokens are estimated from characters, not counted by a runtime's tokenizer, and no real model ran.
- The Focus chip that shows the `PackReport` is not built yet ([#1382](https://github.com/otaviobarros/hobbots/issues/1382)).
- The camp brief is not in the pack yet, since no projector writes it ([#1384](https://github.com/otaviobarros/hobbots/issues/1384)).

# The hub's brain answers a judgment on signed-in Claude Code and Codex

- **Date:** 2026-11-11
- **Issue:** [#1367](https://github.com/otaviobarros/hobbots/issues/1367)
- **Pull request:** [#1404](https://github.com/otaviobarros/hobbots/pull/1404)
- **Commit:** `27dfcef` on `claude/project-thread-ugsemz`, the pull request branch
- **Setup:** a Mac on macOS 27.0.1 (26A434), from a source checkout with `pnpm install --frozen-lockfile`. Claude Code 2.1.316 signed in with a claude.ai plan; its smallest model, `haiku`, at low effort. codex-cli 0.166.0 signed in with ChatGPT; its smallest model. Real runtime adapters, with no stand-in models, through the hub's model endpoint.
- **Result:** Passed with gaps: in 3 runs, each runtime answered the judgment in its shape every time, and each call was counted for Usage. The Settings rows, the onboarding step and the projectors that call the brain are not built yet.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-1367-08]` | `HOBBOTS_SIGNED_IN=1 npx vitest run test/hub-brain-signed-in.test.ts` in `apps/server`: Claude Code is asked whether "2 + 2 = 4" is true, with "no" as the rule, and must answer "yes" from the brain with a confidence from 0 to 1, as one counted call | ✅ 3 of 3 runs, 4.5 to 5.1 s each, no answer out of shape |
| `[TC-GEN-1367-08]` | The same on Codex | ✅ 3 of 3 runs, 5.0 to 6.6 s each, no answer out of shape |

Earlier runs on this branch found two faults, fixed before this run:

- At `b6cd38c`, with the question in the turn's instructions, Claude Code's smallest model at low effort sometimes answered the input ("4") instead of the JSON, so the rule stood. The question, the input and the answer's shape now go in the prompt.
- At `b8c8d63`, the answer's JSON Schema gave the confidence as a number or the strings `NaN` and `Infinity`, with no range, and the check's question was ambiguous; Claude Code answered it "yes" and "no" in equal parts. The confidence is now `Schema.Finite` from 0 to 1, and the question is plain.

## Gaps

- The Settings rows for the brief, chapter summaries and judgments, and the onboarding step that picks the brain ([#1367](https://github.com/otaviobarros/hobbots/issues/1367)).
- No projector calls the brain yet, so briefs, chapter summaries and camp suggestions are not proven with it or under No AI ([#1364](https://github.com/otaviobarros/hobbots/issues/1364)).
- Not run on the packaged Mac app, and not with a model other than each runtime's smallest.

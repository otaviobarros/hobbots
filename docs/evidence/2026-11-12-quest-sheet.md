# A quest opens in its camp's sheet, and a claim clash shows a Heads-up

- **Date:** 2026-11-12
- **Issue:** [#1390](https://github.com/otaviobarros/hobbots/issues/1390)
- **Pull request:** [#1441](https://github.com/otaviobarros/hobbots/pull/1441)
- **Commit:** the pull request branch `claude/project-thread-dpjyd2`, at `9142f19`
- **Setup:** Linux, from a source checkout with `pnpm install --frozen-lockfile` and `pnpm build` in `apps/web`. The browser cases run in Playwright's Chromium against a hub on SQLite with the scripted quest hub (`HOBBOTS_FAKE_QUEST=black-friday`) on the fake Claude Code runtime. The unit cases run in Vitest; the hub case runs in `apps/server` on SQLite.
- **Result:** Passed with gaps. A camp's quest pill opened its sheet, a quest opened there with Back to the camp, a message from the quest's composer got its steer receipt, the Workbench opened beside the chat and went back to the quest, and two Tasks claiming the same file showed a Heads-up in the camp until one was cancelled. No route or component renders the lanes layout. PostgreSQL in the browser and the packaged app were not part of the run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OR-1390-01]` | `npx vitest run test/claim-machine.test.ts` in `packages/domain`: a fast-check model of open claims puts each clash touching the thread's claims in one group, once, and nothing else | ✅ |
| `[TC-OR-1390-02]` | The same file: two Tasks on one file make one clash, and so do a folder and the files inside it | ✅ |
| `[TC-OR-1390-03]` | `npx vitest run test/claims.test.ts` in `apps/server`: two camps whose Tasks claim a folder and a file in it both list the same clash, a third lists none, and ending one Task clears it | ✅ |
| `[TC-UX-1390-04]` to `[TC-UX-1390-07]` | `npx vitest run src/components/quest-sheet/quest-thread.test.ts` in `apps/web`: the quest's thread holds your request and the lead's plan, what you sent while it ran, the lead's replies while it ran but not a quiet one, notes passed on, and each member's result or failure, oldest first | ✅ |
| `[TC-UX-1390-08]`, `[TC-UX-1390-09]` | `npx vitest run src/components/quest-sheet/quest-pill.test.ts`: the pill counts the camp's own quests under way, sums what is ready for review and what needs you, and hides with none | ✅ |
| `[TC-UX-1390-10]`, `[TC-UX-1390-11]` | `npx vitest run src/components/heads-up/heads-up-model.test.ts`: a clash names each side and who claimed last, marks a side whose work is in another chat or camp, and sits under the last message written before the clash began | ✅ |
| `[TC-UX-1390-12]` | `npx playwright test e2e/quest-sheet.e2e.ts`: the pill opens the camp's sheet, a quest row opens the quest in it with each hob's work, a message from its composer reads "Aldric got it", Show the work opens the Workbench and Back to the quest returns, and Back to the camp and Escape close it | ✅ |
| `[TC-UX-1390-13]` | The same file: Quill and Ada both claiming `checkout/payments.ts` show "Heads-up: 2 tasks change the same files" in the camp, and it goes once Quill's Task is cancelled | ✅ |

## Gaps

- The browser cases ran on SQLite only; the clashes the hub serves are proven on PostgreSQL by the server suite in CI, not in the browser.
- The quest adds no unread marker of its own: the camp's unread dot and the folded chat's rail stand for it.
- The design's Pause on a quest is not built, since quests have no pause.
- The quest's sheet no longer has a per-hob try picker or a "Show technical steps" switch: a Task's tries are picked in the Workbench, which shows the exact commands. The browser tests that used them now pick the try in the Workbench.
- `[TC-IN-152]` fails in this container on `main` too (the reply's Stop stays past five seconds after the push is allowed); it is not part of this change.
- Not run on the packaged Mac app.

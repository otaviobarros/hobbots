# Two windows show the status the hub publishes, the same on each

- **Date:** 2026-11-12
- **Issue:** [#1374](https://github.com/otaviobarros/hobbots/issues/1374)
- **Pull request:** [#1429](https://github.com/otaviobarros/hobbots/pull/1429)
- **Commit:** `7df213e` on the pull request's branch
- **Setup:** Linux, from a source checkout with `pnpm install --frozen-lockfile` and `pnpm build` in `apps/web`. The browser cases run in Playwright's Chromium against a hub on SQLite with the fake Claude Code runtime, two browser contexts admitted as two devices; the Quest case runs on the scripted quest hub. The unit cases run in Vitest with the hub's reads answered by the test.
- **Result:** Passed with gaps. Both windows showed the same hob presence, thread run and Quest progress through a full turn, a stop and a Quest step, and a failed status read said so and recovered on Try again. PostgreSQL and the packaged app were not part of the browser run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-UX-1374-01]` | `npx vitest run src/api/hub-status.test.ts` in `apps/web`: a status event that came while the snapshot was read is kept over the older snapshot | ✅ |
| `[TC-UX-1374-02]` | The same file: a `Ready` drops what the window held and reads the snapshot again, so a restarted hub's low revisions still win | ✅ |
| `[TC-UX-1374-03]` | `npx vitest run src/api/quest-summaries.test.ts`: a fast-check model of changes and reads arriving in any order ends with each Quest's newest summary | ✅ 60 runs |
| `[TC-UX-1374-04]` | `npx vitest run src/components/quest/quest-progress.test.ts`: a Quest's pill shows the summary the hub published, ready for review included, never its Task states | ✅ |
| `[TC-UX-1374-07]` | The same file: a failed step of a Task working alone counts as needing you while it runs, and not once it ended | ✅ |
| `[TC-UX-1374-08]` | `npx vitest run src/api/hub-reads.test.ts`: a failed status or summaries read is told apart from an empty one, and Try again reads it again | ✅ |
| `[TC-UX-1374-10]` | The same file: a status read that failed stays failed when a later status frame patches what the window holds, and so does a failed summaries read when a summary event patches its set, until a read answers | ✅ |
| `[TC-UX-1374-05]` | `npx playwright test e2e/hub-status.e2e.ts`: two devices show Pip working and then resting, in the sidebar and the chat header, through a full turn and through a stop | ✅ |
| `[TC-UX-1374-06]` | The same file: two devices show the same pill ("1 needs you", "of 2 done"), ticket and lead needing you, and both follow the Quest to "Finished in" once one answers | ✅ |
| `[TC-UX-1374-09]` | The same file: with `/api/status` failing, the window says it could not read the hob's status, a paused hob still shows paused, and Try again clears the notice once the hub answers | ✅ |

## Gaps

- The browser cases ran on SQLite only; the status and summaries the hub serves are proven on PostgreSQL by the server suites, not in the browser.
- A Task working alone has no Quest and so no summary: its pill still counts its own steps, questions and approvals in the window.
- The quest pill shows the "ready for review" count that [#1422](https://github.com/otaviobarros/hobbots/issues/1422) defined, proven by `[TC-UX-1374-04]` only: no browser case delivers a reviewable artifact.
- Not run on the packaged Mac app.

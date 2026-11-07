# A hob's skills, What changed, To review and a skill's Activity, in the browser against the hub

- **Date:** 2026-11-07
- **Issue:** [#1062](https://github.com/otaviobarros/hobbots/issues/1062)
- **Pull request:** [#1138](https://github.com/otaviobarros/hobbots/pull/1138)
- **Commit:** `f28e5484` on `claude/project-thread-u5l560`, with a clean tree
- **Setup:** Linux x86_64 container (Node 22). The web client built with Vite and served by the hub, on SQLite with the fake runtime, driven by Playwright in the preinstalled Chromium, with the axe accessibility scan. No desktop app, no PostgreSQL, no real runtime or model.
- **Result:** Passed with gaps. In the browser, a hob was given a skill from its Skills tab and in Summon, turned a shared skill off and on from its profile, a save and its rollout were rolled back from What changed, a hob's draft was added from To review, and a hob's note showed in the skill's Activity, also after a failed read; the desktop app was not run.

## In the browser

`pnpm --filter @hobbots/web exec playwright test hob-skills skills skill-proposals --repeat-each 3`, after `vite build`

| Case | Check | Result |
|---|---|---|
| `[TC-UX-1062-05]` | Pip's Skills tab gives Pip a skill from the picker; its profile turns Everyone's skill off for Pip, then on again from the picker | ✅ Each said what changed from the next chat; the switch followed; no serious or critical accessibility violations |
| `[TC-UX-1062-06]` | What changed after a hob's skill was edited; Roll back; Activity with a note Pip left through `skill_feedback`; the notes' read fails, then Try again | ✅ The save read as rolled out to 1 place, Roll back moved it to r1; the note showed with "2 more notes suggest a revision"; the failure said so apart from the uses, and Try again showed the note |
| `[TC-UX-1062-07]` | Summon with Everyone's skill and one picked | ✅ Everyone's skill was not offered again; the hob arrived carrying 2 skills |
| `[TC-UX-1062-08]` | A hob's `skill_propose` draft in Skills › To review, then Add | ✅ Counted in the nav, shown with its diff and why, added for the hob; the count went away |
| `[TC-UX-1062]` to `[TC-UX-1062-04]`, `[TC-UX-1063-01]` and on | The Skills page and the Inbox's proposals, again | ✅ Unchanged |

Every case passed 3 runs out of 3.

## Through the hub and the client

`pnpm --filter @hobbots/server exec vitest run test/skills.test.ts test/skill-assignments.test.ts test/skill-proposals.test.ts`, and `pnpm --filter @hobbots/web exec vitest run`

| Case | Check | Result |
|---|---|---|
| `[TC-AG-151]` | What changed after an edit with a hold, a rollback through a rollout, and a skill imported then removed | ✅ Each save with its rollout and holds, each move with the revision it came from, the removed skill by its name |
| `[TC-AG-160]` | A save moves one place from r2 and another, rolled back earlier, from r1 | ✅ Each move keeps its own revision; no single revision is named for Roll back |
| `[TC-AG-144]` | A hob's skills with the projects it works in | ✅ Both projects, then one |
| `[TC-UI-1062-01]` to `[TC-UI-1062-03]` | What a hob carries, what the picker offers, and the lines of What changed | ✅ |
| `[TC-UX-1062-09]` | A note lands while the first read of a skill's notes is under way | ✅ That read is cancelled and a new one shows the note; the test fails without the fix |

## Gaps

- The desktop app was not run ([#1062](https://github.com/otaviobarros/hobbots/issues/1062)).
- What changed, To review and the notes were not run on PostgreSQL here; CI runs the server suites on it.
- Updates, and update requests in To review, come with [#1097](https://github.com/otaviobarros/hobbots/issues/1097).

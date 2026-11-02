# Tasks and Quests run end to end, through a restart

- **Date:** 2026-11-02
- **Issue:** [#280](https://github.com/otaviobarros/hobbots/issues/280)
- **Pull request:** [#399](https://github.com/otaviobarros/hobbots/pull/399)
- **Commit:** not yet on `main` (ran on the pull request branch, which starts from `main` at `9ced54d`)
- **Setup:** Linux x86_64, Node 22.23.4, the fake runtime. Hub cases on SQLite in memory and on PostgreSQL 16.15 (a local server on port 54329, as `pnpm test:pg` uses). Hobs named Aldric, Quill, Ada, Rook and Pip, under the Balanced preset in one project folder. The restart case starts a second hub over the database of a first one that stopped mid-Quest without ending its turns, as a crash leaves it.
- **Result:** Passed with gaps. A request runs end to end from one message: Aldric's steps, a party with a hand-off through him, a question he answers and one he passes up to you, and a nested Quest whose loop the limits stop. Retry, Reassign, Cancel Task and Cancel Quest end with confirmed outcomes, a This Task grant holds across a restart and ends with the Quest, and a restart mid-Quest loses and duplicates nothing. The run found two gaps in what the backpack leaves behind; one is fixed since ([#397](https://github.com/otaviobarros/hobbots/issues/397)), and the other is open. Real Claude Code was not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OR-170]` | From one message, Aldric plans four steps in a row and brings in Quill, Ada (after Quill) and Rook. Each step runs in a fresh session told "step 2 of 4" and so on, and Aldric hears their results but never their prompts. Quill's question is answered by Aldric, and Quill goes on in his own session. Ada's question is passed up by Aldric and answered by you. Ada waits until Aldric hands her Quill's copy, then finishes. Rook brings in Pip, whose calls to hand work back to Aldric (`cycle`) and to go one level deeper (`depth-limit`) are refused with nothing written. Her result reaches Rook and never Aldric's chat. Nine Tasks and both Quests complete, and nothing is left in any backpack, routine progress included: since [#401](https://github.com/otaviobarros/hobbots/pull/401), Rook gets Pip's progress along his turns ([evidence](2026-11-02-nested-lead-progress.md)). | ✅ SQLite, PostgreSQL |
| `[TC-OR-171]` | In one Quest, a step whose session fails is retried once fixed, as a second Attempt of the same Task. Cancel Task on Rook stops Pip's running turn and confirms both, while Aldric's Quest goes on. Ada retires mid-turn, so her Task fails, and Reassign gives it to Rook, who finishes it from the brief with her Attempt kept. Cancel Quest stops Quill's turn and confirms every Task still open, with both Quests cancelled. No prompt is sent after it. | ✅ SQLite, PostgreSQL |
| `[TC-OR-172]` | A hub stops while Quill's turn runs and Ada's question, passed up by Aldric, waits for you. The next start ends Quill's Attempt as interrupted and resumes his session, without sending his brief again. The Tasks, Quest, delegations and question are the same records, and the question still waits for you. Your answer reaches Ada once, and the hand-off reaches her once. The Quest completes with three Tasks, one question, one hand-off and Ada's three turns, your four messages are each kept once, and no Attempt is left live. | ✅ SQLite, PostgreSQL |
| `[TC-PE-263]` | Aldric approves a push in his chat for This Task while Quill works. After a restart, his next push runs without asking you, with the grant marked used. Quill's own push in his turn after the restart asks you, bound to the same top Task. Cancelling the Quest revokes the grant as `task-ended`. | ✅ SQLite, PostgreSQL |

The four cases passed 10 of 10 runs alone on each database. The persistence and server suites passed in full on each database, except `[TC-DP-008]`, which needs IPv6 and fails in this container on `main` too.

## Gaps

- Cancelling a Quest while its lead's continuation reads its party's work leaves that work waiting for the lead after the Quest has ended. The stopped turn's items go back to pending, as does the failure the cancel sends for a member's Task, and nothing dispatches them again. `[TC-OR-171]` waits for Aldric's replies to end before it cancels. ([#396](https://github.com/otaviobarros/hobbots/issues/396))
- Real Claude Code playing any of this was not run: serving the hob tools to a real Claude Code is not verified yet ([#271](https://github.com/otaviobarros/hobbots/issues/271)).
- The packaged Electron app was not run. The browser cases that follow the same Quest in the Quest tab, chat and Inbox (`[TC-CH-190]` to `[TC-CH-193]`, `[TC-IN-132]`, `[TC-IN-154]`) were not run again for this record.

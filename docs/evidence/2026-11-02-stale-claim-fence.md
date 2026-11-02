# A turn whose backpack claim ran out writes nothing through the hob tools

- **Date:** 2026-11-02
- **Issue:** [#375](https://github.com/otaviobarros/hobbots/issues/375)
- **Pull request:** [#378](https://github.com/otaviobarros/hobbots/pull/378)
- **Commit:** not yet on `main` (ran on the pull request branch at `b28f213`, which builds on `main` at `21a1a18`)
- **Setup:** Linux x86_64, Node 22.23.4, the fake runtime. Hub cases on SQLite in memory and on PostgreSQL 16.15 (a local server on its own data folder and port). A party of three hobs, Aldric leading Quill and Ada, on a Quest in one chat, and the hob tools against a real database.
- **Result:** Passed with gaps. A hob tool call from a turn whose claim ran out, or passed to another turn, writes nothing and is refused as `claim-stale`, for every tool that writes. A turn whose claim is found lost as its runtime accepts it stops. Real Claude Code was not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-IN-166]` | Quill's turn holds a claim on her Task item. While it holds, her calls go through. Once it is expired, every hob tool that writes is refused as `claim-stale`, naming the item, with no journal entry and no Task added: `plan_steps`, `start_quest`, `delegate_task`, `report_checkpoint`, `ask`, `answer`, `escalate`, `hand_off`, `wait_for`, `complete_task` and `cancel_task`. A key the turn already used is refused too. Once another turn claims the item, the first turn is still refused and the new turn's `delegate_task` goes through. | ✅ SQLite, PostgreSQL |
| `[TC-IN-167]` | Aldric's continuation is accepted, and its `delegate_task` to Ada, with a fresh key, is held while its claim renewals freeze on a 300 ms lease. Once the claim is expired, the held call is refused (`claim-stale`), and so is the `complete_task` after it. Ada has no Task, delegation, Attempt or session. The next continuation claims Quill's result under a newer token and completes the launch, after two deliveries. | ✅ SQLite, PostgreSQL |
| `[TC-IN-164]` | Aldric's continuation stalls before its runtime starts, and its claim is expired. When the runtime then accepts the turn, it stops at once and makes no call; the dispatcher drops its outcome. A second continuation completes the launch. | ✅ SQLite, PostgreSQL |

Each case passed 10 of 10 runs on each database. With the fence turned off, `[TC-IN-166]` and `[TC-IN-167]` fail. The persistence and server suites pass on PostgreSQL, except `[TC-DP-008]`, which needs IPv6 that this container lacks.

## Gaps

- Real Claude Code serving the hob tools was not run ([#271](https://github.com/otaviobarros/hobbots/issues/271)).
- A turn whose claim is lost mid-turn stops once its next renewal is refused, within a third of the lease. A turn whose renewals stall, as when its worker cannot reach the database, runs on until they resume, though every hob tool call it makes in the meantime is refused. No case drives a renewal that stalls and then fails.

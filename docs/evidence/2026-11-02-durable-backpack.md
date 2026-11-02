# A hob's backpack holds end to end, under injected faults

- **Date:** 2026-11-02
- **Issue:** [#298](https://github.com/otaviobarros/hobbots/issues/298)
- **Pull request:** [#372](https://github.com/otaviobarros/hobbots/pull/372)
- **Commit:** not yet on `main` (ran on the pull request branch at `354f75f`, which builds on `main` at `4b7d916`)
- **Setup:** Linux x86_64, Node 22.23.4, the fake runtime. Hub cases on SQLite in memory and on PostgreSQL 16.15 (a local server on its own data folder and port). A party of three hobs, Aldric leading Quill and Ada, on a Quest in one chat.
- **Result:** Passed with gaps. The six done-when checks of Slice 10 hold with faults injected where the slice must hold: a late result continues its lead once, thirty updates start no turn, a restart before the lead hears of a result loses nothing, a redelivery makes no second Task or effect, an expired claim is reclaimed under a new fencing token, and exhausted retries become a blocker. Real Claude Code was not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-IN-160]` | Quill's `complete_task` is held until Aldric's turn has ended. Her result then starts one continuation in Aldric's session, written by Hobbots and naming her result, which completes the launch. Nothing is left in any backpack. | ✅ SQLite, PostgreSQL |
| `[TC-IN-161]` | Quill reports thirty progress updates after Aldric's turn ended. With the hub's own "started" update they wait as 31 routine items and start no turn, even with Aldric's thread woken. Her result then starts exactly one continuation, whose digest reads "31 updates in all" with the latest, "Draft 30 written". It consumes every update. | ✅ SQLite, PostgreSQL |
| `[TC-IN-162]` | The hub stops right after Quill's result commits, before any delivery. A second hub on the same database continues Aldric once and completes the launch: one Task and one Attempt for Quill, one delivery of her result, one continuation, and no rerun of her turn. | ✅ SQLite, PostgreSQL |
| `[TC-IN-163]` | Aldric's continuation brings Ada in, and the provider cuts it off. Delivered again, it makes the same call with the same key: one Task, one delegation and one session for Ada. Quill's result was delivered twice and consumed once. | ✅ SQLite, PostgreSQL |
| `[TC-IN-164]` | Aldric's continuation stalls and its claim renewals freeze, on a 300 ms lease. Every claim it held is expired with a raised fencing token, and a renewal under the old claim is refused as stale. The stalled turn's `complete_task` is refused (`items-open`). A second continuation claims the result under a newer token and completes the launch, after two deliveries. | ✅ SQLite, PostgreSQL |
| `[TC-IN-165]` | Every continuation is cut off. After three deliveries Quill's result fails with a blocker (`retries-exhausted`, next action `retry`, `afterDeliveries` 3). No more turns start, and her Task keeps its result. Retry delivers it again, and Aldric completes the launch. | ✅ SQLite, PostgreSQL |

The new suite passed 10 of 10 runs on each database. The persistence and server suites pass on PostgreSQL, except `[TC-DP-008]`, which needs IPv6 that this container lacks.

## Gaps

- Real Claude Code serving the hob tools was not run ([#271](https://github.com/otaviobarros/hobbots/issues/271)).
- A real crash of the packaged app was not run. The restart is two hubs, one after the other, on one database ([#295](https://github.com/otaviobarros/hobbots/issues/295)).
- A turn whose claim expired before the runtime accepted it still runs to its end. `[TC-IN-164]` proves only that its `complete_task` is refused and that the dispatcher drops its outcome. Other hob tool calls it makes are not checked against the claims it carried: a `delegate_task` with a fresh key would still create a Task. This predates this run and is not tracked by an issue yet.

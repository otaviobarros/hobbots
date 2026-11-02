# Cancelling a Quest leaves nothing waiting in any backpack

- **Date:** 2026-11-02
- **Issue:** [#396](https://github.com/otaviobarros/hobbots/issues/396)
- **Pull request:** [#413](https://github.com/otaviobarros/hobbots/pull/413)
- **Commit:** not yet on `main` (ran on the pull request branch, on top of `main` at `c1a8a82`, with the code as it is in this record's commit)
- **Setup:** Linux x86_64, Node 22.23.4, the fake runtime. Hub and dispatcher cases on SQLite in memory and on PostgreSQL 18.6 (a local server on port 54329, as `pnpm test:pg` uses). A party of Aldric leading Rook and Quill on a Quest in one chat, and the dispatcher against a real database.
- **Result:** Passed with gaps. Once a cancelled Quest's Tasks have stopped, what a stopped turn carried, what the cancel sent the lead and the party's routine progress all resolve as late, with no turn started for them, on both databases. Real Claude Code and the browser were not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OR-180]` | Hub level: Rook finishes and Aldric's continuation reads his result, held once its session has started, while Quill still works. Cancel Quest stops the continuation (it ends stopped), confirms Aldric's and Quill's Tasks cancelled, and leaves nothing open in any backpack: Rook's result, the failure item about Quill and the progress the turn carried resolve as late. Nothing starts after. On `main` four items stay pending. | ✅ SQLite, PostgreSQL (10 of 10) |
| `[TC-OR-181]` | Dispatcher: Quill's Task is cancelled while his turn reads its item, the turn ends stopped, and no turn is planned again. The item resolves as late at the Task's version instead of going back to pending. | ✅ SQLite, PostgreSQL |
| `[TC-OR-182]` | Dispatcher: the same, with the turn interrupted instead. The item resolves as late, with no claim left. | ✅ SQLite, PostgreSQL |
| `[TC-OR-183]` | Dispatcher: an item whose Task was cancelled resolves as late although no turn can start, and no turn is planned for it. | ✅ SQLite, PostgreSQL |
| `[TC-OR-184]` | Hub level: Rook's step reports progress and finishes, and Rook's continuation reads its result, held, while Aldric waits on Rook with the progress pending for him. Cancel Quest leaves nothing open in any backpack, Rook's Task item and Aldric's progress included. Nothing starts after. On `main` Rook's Task item stays pending. | ✅ SQLite, PostgreSQL (10 of 10) |
| `[TC-OR-185]` | Unit: cancelling Quill's Task takes only the late work about it, and leaves the work Rook holds under his failed, retryable sibling Task; once the Quest itself is being cancelled, Rook's work is taken too. | ✅ |

The server and persistence suites passed on each database, except `[TC-DP-008]`, which needs IPv6 and fails the same way on `main` in this container. Retrying a failed step, `[TC-OR-147]`, still passes on PostgreSQL: a member's failed Task can be retried, so the work about it is not resolved when it fails.

## Gaps

- Real Claude Code was not run: serving the hob tools to a real Claude Code is not verified yet ([#271](https://github.com/otaviobarros/hobbots/issues/271)).
- The browser was not run. `[TC-OR-171]` in [#280](https://github.com/otaviobarros/hobbots/issues/280) proves Cancel Quest from the Quest tab without waiting for Aldric to go idle once this merges.
- The packaged Electron app was not run.

# A member that leads a nested Quest is left with nothing pending

- **Date:** 2026-11-02
- **Issue:** [#397](https://github.com/otaviobarros/hobbots/issues/397)
- **Pull request:** [#401](https://github.com/otaviobarros/hobbots/pull/401)
- **Commit:** not yet on `main` (ran on the pull request branch at `0ebed6e`, which builds on `main` at `907f787`)
- **Setup:** Linux x86_64, Node 22.23.4, the fake runtime. Hub cases on SQLite in memory and on PostgreSQL 16.15 (a local server on its own data folder and port). The nested Black Friday party: Aldric leads Rook, who leads Pip.
- **Result:** Passed with gaps. Rook now gets Pip's routine progress as a digest along the turn her result starts, and never in a turn of its own. Once the Tasks it is about have ended, no backpack holds anything open, routine progress included. Real Claude Code was not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OR-185]` | Hub level: while Pip's turn is held, her `started` waits in Rook's backpack and Rook gets no new turn. Her result wakes Rook once, with her two updates as one digest line. Once all three Tasks and both Quests complete, nothing is open in any backpack. | ✅ SQLite, PostgreSQL |
| `[TC-OR-186]` | Ledger: a lead's routine progress never blocks its completion. The completion resolves the progress no turn carried as late, at the version its Task ended, and leaves the progress a running turn holds to that turn. | ✅ SQLite, PostgreSQL |
| `[TC-OR-187]` | Unit: a member's progress for the member that leads it is carried by that leader's Task session. It never wakes that session and never goes to a thread. | ✅ |

## Gaps

- Progress left pending when a lead's Task is cancelled or fails, instead of completing, is settled with the cancel path in [#396](https://github.com/otaviobarros/hobbots/issues/396).
- Real Claude Code leading a nested Quest was not run: serving the hob tools to a real Claude Code is not verified yet ([#271](https://github.com/otaviobarros/hobbots/issues/271)).

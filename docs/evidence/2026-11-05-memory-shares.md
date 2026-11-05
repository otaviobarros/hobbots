# You review what hobs want to share, under each preset

- **Date:** 2026-11-05
- **Issue:** [#960](https://github.com/otaviobarros/hobbots/issues/960)
- **Pull request:** [#984](https://github.com/otaviobarros/hobbots/pull/984)
- **Commit:** the head of `claude/project-thread-8bt55z`, the branch of the pull request, after merging `main` at `2938f51`; not yet on `main`.
- **Setup:** Linux x86_64 container (Ubuntu 24.04.5, Node 22.23.4) with ai-memory 3.4.2 for `linux-x64`, fetched and checked by `pnpm --filter @hobbots/memory fetch-engine`. Hub-level cases run the whole API over a SQLite test database, the fake runtime and the in-memory `MemoryStore`, calling `memory_save` through the hob's memory tools and deciding over HTTP with this computer's window key.
- **Result:** Passed with gaps: memory 110 tests (the ai-memory contract included), domain 156, agents 17, persistence 161 of 162, web 837, desktop 152, and the server's memory cases 32. The persistence failure is the migration ids check, which waits for `0058` from [#981](https://github.com/otaviobarros/hobbots/pull/981); this branch's migration is `0059`. The whole server suite passes but for `[TC-DP-008]`, which needs IPv6, which this container lacks, and fails on `main` too.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-360]` | Under Careful and Balanced a share to a project waits for you, the hob is told so, nothing is written, and each is journaled once | ✅ hub, fake memory |
| `[TC-GEN-361]` | Under Trusting a share to a project goes through, written as the hob, and Undo takes it out of the project and leaves it in the hob's own memory | ✅ hub, fake memory |
| `[TC-GEN-362]` | A share with every hob (About you) waits under Careful, Balanced and Trusting | ✅ hub, fake memory |
| `[TC-GEN-363]` | A retried key records one share and answers where it now stands, kept private included | ✅ hub, fake memory |
| `[TC-GEN-364]` | Under Trusting, a share memory does not take waits for you instead | ✅ hub, fake memory |
| `[TC-GEN-365]` | Share it writes the page as the hob, records you as having approved it, and a second decision is refused with nothing written | ✅ hub, fake memory |
| `[TC-GEN-366]` | Edit, then share writes your edit, still as the hob, marked edited | ✅ hub, fake memory |
| `[TC-GEN-367]` | Keep it private puts the page in the hob's own memory and never in the shared one | ✅ hub, fake memory |
| `[TC-GEN-368]` | Undo brings back the page a share replaced, and refuses a page you changed since, leaving your change | ✅ hub, fake memory |
| `[TC-GEN-369]` | A decision runs only with your session: not from a hob's turn, and not over HTTP without the window's key | ✅ hub, fake memory |
| `[TC-GEN-370]` | Check now lists what it found in every scope, keeps the last check, and puts nothing in the Inbox | ✅ hub, fake memory |
| `[TC-GEN-371]` | Check now answers 503 while memory does not answer, and keeps the last check | ✅ hub, fake memory |
| `[TC-GEN-372]` | A store's check finds nothing among distinct fresh pages, adds no page of its own, and is yours alone | ✅ fake and ai-memory 3.4.2 |
| `[TC-GEN-373]` | A page flagged as out of date with ai-memory's `memory_feedback` shows as out of date in Check now, and the dry run leaves the page as it was | ✅ ai-memory 3.4.2 |
| `[TC-DP-270]` to `[TC-DP-272]` | The share record keeps one share per key in the same work or the reply's, lets only the first of two decisions land, lists what waits then the latest decided, and refuses an unknown state | ✅ SQLite |
| `[TC-UX-980]` to `[TC-UX-983]` | A share's title, lines and outcome; To review's list and the decided share kept open; the Inbox's Memory kind with No rush, grouped apart; the version a share wrote, for Undo in What changed | ✅ unit |
| `[TC-IN-560]` | The desktop app announces a share, opens it in the Inbox, closes it once decided, and reads again on a share's journal entries | ✅ unit |

## Findings

- ai-memory 3.4.2's `memory_lint` accepts `dry_run`, and with it writes no `_lint/report.md` among your pages. Its findings name pages by path; contradictions, stale pages and pages flagged by `memory_feedback` are the ones Check now shows.
- The fake runtime's tools and the Memory page now share one store, so a share approved on the fake shows on the Memory page.

## Gaps

- The Inbox's Memory kind, Memory › To review, Check now and Undo in What changed are not run in a browser, nor checked against the design in each theme.
- Check now's findings are kept in the hub's memory, so a restart clears the last check.
- Not run on macOS, nor in the packaged app, nor with a real Claude Code or Codex turn calling `memory_save` ([#964](https://github.com/otaviobarros/hobbots/issues/964)).

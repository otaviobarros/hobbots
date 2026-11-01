# Threads are archived, found, read and restored without losing history

- **Date:** 2026-11-01
- **Issue:** [#257](https://github.com/otaviobarros/hobbots/issues/257)
- **Pull request:** not yet opened
- **Commit:** not yet on `main` (ran on the pull request branch, on top of `ca45e4a`)
- **Setup:** Automated only, with the fake runtime, which writes each reply word by word and decides scripted tool calls with the hub's policy engine. Linux x86_64, Node 22.23.4. The hub-level cases go through the HTTP API with the hub's own composition (setup, policy engine, approvals and search) and ran on SQLite in memory and on PostgreSQL 16; CI runs them on SQLite and PostgreSQL 18. The browser cases ran with Playwright 1.64.1 and Chromium 153 against a hub from source on a SQLite file.
- **Result:** Passed. An archived thread leaves the hob's list, is found in the Archived list and by search, opens read-only and comes back whole on Restore, and archiving is refused while a reply runs or an approval waits, without interrupting either.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-CH-165]` | Hub level, SQLite and PostgreSQL: an archived thread leaves the hob's list and is the only one in its archived list. Search finds it with `archivedAt` set. Its messages read as before and a new message is refused with `ThreadArchived`. Restore puts it back in its place by last activity with its history, and it takes a new message. | ✅ 5 of 5 repeated runs on each database passed. |
| `[TC-CH-166]` | Hub level, SQLite and PostgreSQL: archiving while a reply streams is refused with `reply-running`, the thread stays listed and the reply completes whole. Once it ends, the archive succeeds. | ✅ 5 of 5 repeated runs on each database passed. |
| `[TC-CH-167]` | Hub level, SQLite and PostgreSQL: archiving while a push waits for approval is refused with `approval-pending`, and the reply stays open. Once the user decides and the reply ends, the archive succeeds. | ✅ 5 of 5 repeated runs on each database passed. |
| `[TC-CH-157]` | Browser: archive a thread from its row's ⋯ menu, see it leave Pip's list, open it from Archived · 1 and from search (tagged Archived) with the banner and no composer, restore it and send it a new message. | ✅ 8 of 8 repeated runs passed. |
| `[TC-CH-152]`, `[TC-CH-156]` | Existing browser cases: Archive thread is disabled with its reason, by menu and by ⌃⌘A, while Pip replies and while Pip waits for approval, and Show request focuses the approval card. | ✅ |
| `[TC-CH-150]`, `[TC-CH-151]`, `[TC-CH-153]`, `[TC-CH-154]`, `[TC-CH-155]` | Existing browser cases: archiving the open thread opens the next one, Undo and ⌘Z bring it back, and a failed or refused archive or undo puts things back with Try again. | ✅ |
| `[TC-CH-160]` to `[TC-CH-164]` | Existing browser cases: the Archived list, its empty state, search results and an archived thread opened by its address stay read-only. | ✅ |
| `[TC-CH-140]` to `[TC-CH-148]` | Existing hub cases: archive and restore are idempotent and live, a waiting message or approval refuses the archive, a retired hob's archived threads stay as they are, and the HTTP API lists archived threads apart. | ✅ |

## Gaps

- Only the fake runtime ran. Archiving does not reach the runtime, so real Claude Code is not needed to prove it, but a packaged app on macOS was not part of this run.
- The browser cases ran on SQLite only, as the end-to-end CI job does. PostgreSQL is covered at hub level.

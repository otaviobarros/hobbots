# Reliable chat survives a crash, time offline, an expired cursor and a restored backup

- **Date:** 2026-10-31
- **Issue:** [#118](https://github.com/otaviobarros/hobbots/issues/118)
- **Pull request:** [#194](https://github.com/otaviobarros/hobbots/pull/194)
- **Commit:** not yet on `main` (ran on the pull request branch at `1b50ecc`)
- **Setup:** Automated only, with the fake runtime, which writes one word every 40 ms (25 chunks a second). Linux x86_64, Node 22.23.4. The hub-level cases ran on SQLite in memory and on PostgreSQL 16; CI runs them on SQLite and PostgreSQL 18. The browser cases ran with Playwright 1.64.1 and Chromium 153 against a hub from source on a SQLite file, since the hub stores its data only in SQLite. The browser reaches the hub through a TCP relay the test can cut, so a dropped connection is a real one.
- **Result:** Passed with gaps. A crash mid-reply, a reconnect mid-reply, time offline, an expired cursor and a restored backup each end with every message shown once and the text the hub stored. The packaged app and real Claude Code were not part of this run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-CH-120]` | Kill the hub with `SIGKILL` mid-reply and start it again. The reply shows as cut off by the restart, keeps the text the hub had saved, and the thread goes on with every message shown once. | ✅ Over six runs, 147 to 161 of 283 to 297 streamed characters were lost, about 0.6 seconds of text, inside ADR 013's one second. |
| `[TC-CH-121]` | Cut the page off mid-reply. The reply finishes and another window sends a message while it is away. On reconnect the page resumes after its cursor (`Last-Event-ID`), fetches nothing again, and shows each message once with its full text. | ✅ |
| `[TC-CH-122]` | While the page is away, a long reply runs, a message queued behind it is taken back, and another is answered. The journal is then compacted past the page's cursor. On reconnect the page fetches the thread again, the taken-back message is gone, and each message shows once. | ✅ |
| `[TC-CH-123]` | Restore a backup of the database taken before the last exchange. The page drops what it had cached and shows the restored thread. | ✅ |
| `[TC-CH-124]` | Hub level, SQLite and PostgreSQL: a cursor whose entries compaction removed gets a fresh `Ready` and no partial replay. A cursor right before the oldest kept entry still replays every entry after it. | ✅ |
| `[TC-CH-125]` | Hub level, SQLite and PostgreSQL: after a crash mid-reply, a client resuming from before the crash gets each missed entry once, in order, ending with the reply interrupted and its saved text. | ✅ |
| `[TC-CH-071]`, `[TC-CH-073]` | Existing hub-level cases: a resume replays exactly the missed entries; entries committed but never published, as when the hub dies between commit and publish, are read from the journal in order. | ✅ |
| `[TC-CH-076]` | Existing client case: a messages response read before newer events does not undo a finished reply. | ✅ |
| `[TC-CH-064]`, `[TC-CH-065]` | Existing cases: search finds a thread by a word from an old message, at hub level on both databases and in the browser. | ✅ |
| `[TC-CH-102]`, `[TC-CH-103]` | Messages that wait while the hub is away still go out in order. These failed about once in 30 runs because a check matched the words of a streaming reply and the next queued message together, and read the thread before the last message had started. The checks now match a reply's whole text. | ✅ 80 of 80 runs passed after the change. |

## Gaps

- Only the fake runtime ran. A crash with real Claude Code on the packaged app is not recorded: [#70](https://github.com/otaviobarros/hobbots/issues/70).
- The page was offline for seconds, not a minute. What it misses, not how long it waits, decides the replay, and the hub keeps entries for seven days.
- Compaction was simulated by deleting journal entries, since real compaction keeps seven days and the latest 10,000 entries. Its own rule is checked by `[TC-DP-030]`.
- The browser cases run on SQLite only, because the hub stores its data only in SQLite. PostgreSQL is checked at hub level.

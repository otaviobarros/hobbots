# Approvals hold end to end: rules, doubled clicks, expiry and the Inbox

- **Date:** 2026-11-01
- **Issue:** [#217](https://github.com/otaviobarros/hobbots/issues/217)
- **Pull request:** [#PR](https://github.com/otaviobarros/hobbots/pull/PR)
- **Commit:** not yet on `main` (ran on the pull request branch, based on `ca45e4a`)
- **Setup:** Automated only, with the fake runtime, which decides each scripted tool call with the hub's policy engine and runs nothing. Linux x86_64, Node 22.23.4. The hub-level cases go through the HTTP API with the hub's own composition (the setup's preset and folders, one policy engine, grants) and ran on SQLite in memory and on PostgreSQL 16.15; CI runs them on SQLite and PostgreSQL 18. The 24-hour case moves the hub's clock forward instead of waiting a day. The browser cases ran with Playwright 1.64.1 and Chromium's headless shell against a hub from source on a SQLite file.
- **Result:** Passed with gaps. An Always rule shows in History, answers the next matching action and, once removed, the next one asks again; a doubled approval runs the action once and saves one rule; a request left a day expires and cannot be approved; and the Inbox and the chat decide the same way. Real Claude Code was not part of this run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-126]` | Hub level, SQLite and PostgreSQL: Always on `rm build` saves one live rule, listed in History with the request that saved it. The next `rm build` runs with no request. Removing the rule keeps it in History as removed by the user, and the next `rm build` asks again. | ✅ |
| `[TC-PE-127]` | Hub level, SQLite and PostgreSQL: Allow once sent twice at the same moment answers both with the same decision, runs the push once and leaves one request. Always sent twice saves one rule. | ✅ |
| `[TC-PE-128]` | Hub level, SQLite and PostgreSQL: a push request expires 24 hours after it was made. A day less a minute later it still waits; past the day its reply completes with the push refused and never run, the request reads expired in the thread and in the Inbox, and a late Allow once or Always is refused as closed, saving no rule. | ✅ |
| `[TC-IN-017]` | Hub level, SQLite and PostgreSQL: the Inbox lists exactly the requests the threads show. Denying with a reason on the chat's copy of one and the Inbox's copy of another stores the same decision, ends both replies the same way with the reason going back to the hob, and both lists read the stored decisions alike. | ✅ |
| `[TC-PE-129]` | Browser: double-clicking Allow once runs the push once, and double-clicking Save the rule and allow saves one rule. | ✅ 4 of 4 repeated runs passed. |
| `[TC-IN-018]` | Browser: Always from the chat's card and from the Inbox's show the same outcome and save the same kind of rule, both listed in History; Deny with a reason from either shows the same outcome and tells the hob why. | ✅ 4 of 4 repeated runs passed. |
| `[TC-PE-125]` | Existing browser case, renumbered from a duplicate `[TC-PE-121]`: an Always rule shows in Inbox History and Settings, and removing it there makes the next call ask again. | ✅ |
| `[TC-IN-003]`, `[TC-IN-004]` | Existing browser cases: the Inbox and the chat follow each other's decisions, and an expired request shows as expired and cannot be approved. | ✅ |
| `[TC-PE-061]`, `[TC-PE-066]`, `[TC-PE-092]`, `[TC-PE-093]`, `[TC-PE-096]` | Existing hub and persistence cases: a doubled approval runs once and saves one grant in the decision's transaction, a removed rule asks again, and a restart expires pending requests. | ✅ |

## Gaps

- Only the fake runtime ran: nothing was read, written or run. Approvals on real Claude Code are in the [manual checklist](checklists/tools-under-policy.md), which has not been run against this commit: [#8](https://github.com/otaviobarros/hobbots/issues/8).
- The 24-hour expiry ran on a moved clock at hub level. No browser run waited for a request to expire by time; the browser cases expire a request by stopping its reply.
- The browser cases run on SQLite only. PostgreSQL is covered at hub level.

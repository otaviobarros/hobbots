# Hobs use tools within their folders, under the policy

- **Date:** 2026-11-01
- **Issue:** [#137](https://github.com/otaviobarros/hobbots/issues/137)
- **Pull request:** [#241](https://github.com/otaviobarros/hobbots/pull/241)
- **Commit:** not yet on `main` (ran on the pull request branch at `90309b3`)
- **Setup:** Automated only, with the fake runtime, which decides each scripted tool call with the hub's policy engine and runs nothing. Linux x86_64, Node 22.23.4. The hub-level cases go through the HTTP API with the hub's own composition (the setup's preset and folders read at every turn, one policy engine) and ran on SQLite in memory and on PostgreSQL 16; CI runs them on SQLite and PostgreSQL 18. The browser case ran with Playwright 1.64.1 and Chromium 153 against a hub from source on a SQLite file.
- **Result:** Passed with gaps. Under Balanced a hob edits and runs tests in its folder without asking, a read outside its folders is refused whatever the prompt says, and an Ask action holds its turn until the user decides in chat. Real Claude Code was not part of this run; the [manual checklist](checklists/tools-under-policy.md) covers it.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-079]` | Hub level, SQLite and PostgreSQL: under Balanced one reply reads a file, edits it and runs `pnpm test` in the shared folder. Each step is done, the edit is decided on the file's canonical path, and no approval request exists. | ✅ |
| `[TC-PE-080]` | Hub level, SQLite and PostgreSQL: the same edit under Careful waits for the user, and the test command is never called, since commands need reading and editing both allowed. | ✅ |
| `[TC-PE-081]` | Hub level, SQLite and PostgreSQL: a prompt telling the hob it may read personal files asks for a file outside the folder, the same file through `..` and through a link inside the folder, and the hub's database. Each read is refused by the policy, the reply still completes, and nobody is asked. | ✅ |
| `[TC-PE-082]` | Hub level, SQLite and PostgreSQL: a `git push` under Balanced stores a pending request. The reply stays streaming on an awaiting step with no text for as long as nobody decides, and an approval through the API resumes it: the push step is done, the reply completes and no second request is made. | ✅ |
| `[TC-PE-083]` | Browser: under Balanced, Pip's reply shows the edit and `pnpm test` as done and a read of a personal file as refused by the hob's permissions, with no approval card. | ✅ 8 of 8 repeated runs passed. |
| `[TC-PE-074]`, `[TC-PE-075]`, `[TC-PE-076]`, `[TC-PE-078]` | Existing browser cases: the approval card holds the reply until Allow once or Deny with a reason, by keyboard, follows a decision made elsewhere, and needs a confirmation for a high-risk push. | ✅ |
| `[TC-PE-012]`, `[TC-PE-013]` | Existing runtime cases: Claude Code's policy hook allows the edit and test run under Balanced and refuses calls outside the folders. | ✅ |
| `[TC-PE-060]`, `[TC-PE-061]`, `[TC-PE-062]` | Existing hub cases: an Ask pauses the turn until approved or denied, a doubled approval runs once and a denial's reason reaches the hob. | ✅ |

## Gaps

- Only the fake runtime ran: nothing was read, written or run. The [manual checklist](checklists/tools-under-policy.md) for real Claude Code on macOS has not been run against this commit. [ADR 014](../decisions/014-tool-policy-and-enforcement.md#what-131-verified) records the earlier hand checks from #131, without an Ask.
- A command writing or reading outside the folders under the OS sandbox is `[TC-PE-020]`, which runs only on macOS, so CI on Ubuntu skips it.
- The Push Charm is not built, so an approved Push running no workspace hook and pushes with the hub's credentials are not proven: [#225](https://github.com/otaviobarros/hobbots/issues/225).

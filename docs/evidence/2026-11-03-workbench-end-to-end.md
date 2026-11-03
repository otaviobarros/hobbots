# The Workbench shows a Task's work end to end

- **Date:** 2026-11-03
- **Issue:** [#391](https://github.com/otaviobarros/hobbots/issues/391)
- **Pull request:** [#559](https://github.com/otaviobarros/hobbots/pull/559)
- **Commit:** not yet on `main` (ran on the pull request branch, based on `main` at `d526795`)
- **Setup:** Linux x86_64, Node 22.23.4, the fake runtime. Hub cases over the HTTP API and the event stream, on SQLite in memory and on PostgreSQL 16.15 (a local server on port 54329, as `pnpm test:pg` uses). Browser cases with Playwright 1.64.1 on Chrome for Testing 153 (headless shell), against a hub from source on SQLite with the web client's build. Aldric works under the Balanced preset in one folder holding release notes and an old draft.
- **Result:** Passed. A Task that edits files, with a file tool and with a command, and runs commands is followed through every tab while its turn runs and read again as History once it ends, with nothing lost, and a Task that used none of the tabs greys each one out with why. No product code changed. Real Claude Code was not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-UX-060]` | After a turn that starts the Task, Aldric's next turn edits the notes with a file tool, runs a command that adds a changelog and deletes the draft while printing a token and a hub credential as it goes, and runs one more that prints 30,000 lines; the turn is then held open. While it runs, the Attempt's records read through `/api/attempts/:id/activity` show it live, both commands succeeded in the folder and the sandbox with their command line and output redacted, and the three changes not yet settled after the start scan alone. The event stream from the cursor of the thread's read brings the same records, settling to the same view, and the first command's output as it came, redacted; none of the Workbench's journal entries holds either secret. Once the turn ends, the Attempt reads completed, the end-of-turn compare settled each change, the stream brought that compare too, and a client that lost its connection mid-turn catches up from the cursor of its read. The notes' kept contents before and after, the deleted draft's contents, the long command's whole log and the changelog as it is now are each served. | ✅ SQLite, PostgreSQL |
| `[TC-UX-061]` | A Task that edits the notes with a file tool and finishes in one turn records no command, so its Terminal reads Not used, while its settled change and its file are kept and listed. | ✅ SQLite, PostgreSQL |
| `[TC-UX-062]` | In the browser, the second turn of the same kind of Task (edit with a file tool, a command that adds and deletes, a test run) keeps writing its reply for about thirty seconds after its work. Opened from the card meanwhile, the Workbench starts on Summary with Summary, Changes, Files and Terminal reading Live and Browser Coming soon. Changes lists the three files with the notes' added line marked and "So far" while the turn runs; Terminal lists both commands, succeeded, in Aldric's folder, with the token redacted; Files lists the two files still there and previews the changelog; Browser says it comes in a later update. Once the turn ends, every tab reads History in place, with the same files and commands, the deleted draft's earlier contents, a read-only Terminal, and Summary naming the three changed files and the tabs used, its Terminal button opening Terminal. Back to chat finds the chat with the turn ended. | ✅ SQLite |
| `[TC-UX-063]` | In the browser, a Task that only answers and finishes opens on Summary, History, with its result and no buttons to other tabs. Changes, Files and Terminal read Not used in this Task and Browser Coming soon; each opens and says why in a sentence. | ✅ SQLite |

The hub cases passed 10 of 10 runs on each database, and the browser cases 10 of 10 runs, three at a time. The persistence and server suites passed in full on each database, except `[TC-DP-008]`, which needs IPv6 and fails in this container on `main` too.

## Gaps

- Real Claude Code playing any of this was not run, so the Terminal's live output from a real runtime is not verified; Claude Code reports a command's output only when it ends.
- The packaged Electron app was not run, so Show in Finder itself is not verified (`[TC-UX-044]` covers the desktop app's bridge).
- The hub serves the browser on SQLite only, so the browser cases ran on SQLite; PostgreSQL is covered by the hub cases.

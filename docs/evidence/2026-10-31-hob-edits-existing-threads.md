# Hob edits reach existing threads on Claude Code

- **Date:** 2026-10-31
- **Issue:** [#164](https://github.com/otaviobarros/hobbots/issues/164)
- **Pull request:** [#166](https://github.com/otaviobarros/hobbots/pull/166)
- **Commit:** `e591f5b` on `main` (ran on the pull request head `77b38d9`)
- **Setup:** Automated: the server suite and Playwright with the fake runtime, which now keeps a resumed session's first instructions as Claude Code does. Manual: `pnpm package:mac`, then `Hobbots.app` with its own `--user-data-dir` and `HOBBOTS_PORT`, real Claude Code 2.1.301, driven through the hub's HTTP API. The hob was Pip on `haiku` with low effort.
- **Result:** Passed. An edit reaches the next reply in the same thread, and a stopped turn does not leave the session on the wrong instructions.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-AG-022]`, `[TC-AG-097]`, `[TC-AG-098]` | The edited hob, asked for its instructions in the same thread, quotes the edit. Each fails with the fix turned off. | ✅ |
| `[TC-AG-099]` | A turn stopped after it received an edit, then the earlier instructions restored: the next reply follows the restored ones. | ✅ |
| `[TC-AG-100]` | A thread edited before the fix comes back to the current instructions. | ✅ |
| Manual | Version 1, asked to quote its instructions. | ✅ Quotes version 1 |
| Manual | Edit to version 2, ask again in the same thread. | ✅ Quotes version 2 |
| Manual | Ask a question. | ✅ Answers as version 2 says |
| Manual | Stop a long reply after it started, restore version 1, ask for the instructions. | ✅ Quotes version 1 |
| Manual | Ask a question. | ✅ Answers as version 1 says |

## Gaps

- Once a thread spans an edit, every later turn carries the instructions, usually a few hundred tokens. Sending them only until delivery is confirmed needs a stored record of what each session received.

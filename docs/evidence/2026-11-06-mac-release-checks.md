# The v0.0.2 release build on a Mac, on Claude Code and Codex

- **Date:** 2026-11-06
- **Issue:** [#1079](https://github.com/otaviobarros/hobbots/issues/1079)
- **Pull request:** [#PR_NUMBER](https://github.com/otaviobarros/hobbots/pull/PR_NUMBER)
- **Commit:** `d688850` on `main`, tag `v0.0.2`
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64, `Hobbots-0.0.2-arm64.dmg` from the v0.0.2 release (sha256 `e9149d57`), ad hoc signed and run by path with `--user-data-dir` under a scratch folder. Claude Code 2.1.316 with `haiku`, Codex 0.166.0 with `gpt-6-luna`, both on signed-in subscriptions, low effort, Balanced unless a row says otherwise. Git set no global name or email. The window was driven over its debugging port.
- **Result:** Failed on one check. After an update from 0.0.1 the first window ran the old web client until a reload ([#1079](https://github.com/otaviobarros/hobbots/issues/1079), fixed in [#1080](https://github.com/otaviobarros/hobbots/pull/1080) after this tag). Everything else passed, with three new bugs filed.

## Checks

| Case | Check | Claude Code | Codex |
|---|---|---|---|
| Update | 0.0.1 data opens on 0.0.2: migrations from 53 to 64, a backup first, counts kept, memory engine up, About says 0.0.2 | ✅ | ✅ |
| Update | The first window after the update shows Memory | ❌ The cached 0.0.1 client ran: no Memory, and `#/memory` was Not Found until a reload | ❌ Same window, either runtime |
| [#1048](https://github.com/otaviobarros/hobbots/issues/1048) | A command that outlives its turn ends with its real exit code | Not this runtime's path | ✅ |
| Party Quest | A Quest with a nested Quest finishes, with commits, Usage per hob and Memory pages | ✅ Pip led Nettle in the sub-Quest | ✅ Six Tasks, but Pip did Nettle's work itself |
| Party Quest | The hub asks who hobs commit as once, and the commit carries that author | ✅ `Otavio Barros <35647586+otaviobarros@users.noreply.github.com>` | ✅ |
| Quest room | Killing a hob's process three times makes a Stuck card in the chat, the Inbox and the Backpack | ✅ `SIGKILL` of the runtime process, two automatic tries, then Stuck | Not run |
| Quest room | Retry starts a new Attempt, and the Workbench switches between Attempts | ✅ | Not run |
| Quest room | Reassign from the lane menu finishes the Task on another hob | ✅ Quill finished it and the Quest completed | Not run |
| Quest room | The Terminal stays dark and readable on Lamplight Paper and Workshop Daylight | ✅ | Same web client |
| Memory | A note for every hob goes through the Inbox and reaches a hob on the other runtime | ✅ Frodo's note, read by Wren | ✅ |
| Memory | Under Trusting a project lesson shows in What changed, and Undo takes it back | ✅ Frodo, in a new thread, no longer finds it | ✅ Wren saved it. Undo returns it to Wren's own memory, so Wren still finds it |
| Composer | While a hob replies the composer stays one line with Stop and Send after this reply | ✅ | ✅ |
| Composer | Queued messages wait, then go in order | ✅ Second, third and fourth | ✅ Second, third and fourth |
| Composer | Stop ends the reply and keeps what it wrote | ✅ | ✅ |

## Findings

- **[#1079](https://github.com/otaviobarros/hobbots/issues/1079), p0, closed:** the first window after an update runs the old client. This tag has the bug.
- **[#1081](https://github.com/otaviobarros/hobbots/issues/1081), open:** a lead can sit idle with a member's work open, and a Task's `complete_task` can go through with acceptance unmet.
- **[#1082](https://github.com/otaviobarros/hobbots/issues/1082), closed:** a Codex hob was told only that a declined call was rejected.
- **[#1086](https://github.com/otaviobarros/hobbots/issues/1086), p1, open:** a member's Task shows Done when its reply says it isn't finished. Rook's and Nettle's retried Tasks both did.
- **[#1087](https://github.com/otaviobarros/hobbots/issues/1087), p2, open:** the Stuck card, the lane and the Inbox disagree on Reassign, Retry and the Task's state.
- **[#1088](https://github.com/otaviobarros/hobbots/issues/1088), p2, open:** small copy and tool fixes.

## Gaps

- **Gatekeeper and `/Applications`:** the app ran by path and `/Applications` stayed on 0.0.1, so neither the first-open prompts nor replacing the app were checked.
- **Stuck work on Codex:** the kill, Retry and Reassign checks ran only on Claude Code.
- **Identity choice:** the GitHub option was offered on a connected hub, but picking it was not exercised. The answers in the Party Quests were typed.
- **Answers through the API:** many answers and approvals went through the API once the window had shown that kind working.
- **Force quit:** the app was killed with `SIGKILL` from a shell, not from Activity Monitor.
- **The plan's Undo wording:** the plan says a new thread doesn't see the lesson. That held for another hob, not for the hob that saved it, which matches what the app says after Undo.

## Deviations

A copy of 0.0.1 held by a macOS security check started without its test arguments and ran on the tester's real data folder for about 7 minutes, with no messages or turns. It was stopped, `desktop-settings.json` was restored from a backup taken before the run, and the database passed `pragma integrity_check` with the same row counts in seven tables.

# The Quest room follows a party on real Claude Code

- **Date:** 2026-11-05
- **Issue:** [#911](https://github.com/otaviobarros/hobbots/issues/911)
- **Pull request:** [#930](https://github.com/otaviobarros/hobbots/pull/930)
- **Commit:** `ce373dd7` on [#998](https://github.com/otaviobarros/hobbots/pull/998), on `main` at `5f18030`. The run began on the commit before it and went on after [#1003](https://github.com/otaviobarros/hobbots/issues/1003) was fixed.
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64, an ad hoc signed `pnpm package:mac` build, Claude Code 2.1.316, Node 24.15.0. The app ran with its own data folder and an empty project folder on Balanced, signed in with the user's Claude Code login. Aldric led on Sonnet with Rook, Quill, Pip and Nettle, and Pip led Nettle in a nested Quest. The checklist is [the Quest room on real Claude Code](checklists/quest-room.md).
- **Result:** Passed with gaps. One long request ran to "Finished" from the room and the chat column: 5 of 5 Tasks done, 7 of 7 tests passed, no Task, wait, approval or backpack item left open. The run stalled once on a bug that was fixed and then finished after a hub restart. Each lane, the question, the approval and the Workbench did what the checklist expects. Q5 and Q9 show gaps in what the receipt and the chat say.

## Checks

| Case | Check | Result |
|---|---|---|
| Q1 | Manual. Send the request and open the room from its ticket | ✅ A lane per hob with no reload. The ticket stays one line and counts Tasks: "0 of 2 done · 1 needs you", then "5 of 5 done" |
| Q2 | Manual. Watch the lanes | ✅ Beats, edits, commands and hand-off chips came as they happened. "Pip's party" groups Pip and Nettle, and Pip's lane says "Leads Nettle" |
| Q3 | Manual. Answer Rook's question in its lane | ✅ The lane named "Passed up by Rook → Aldric → you". After "R$" it cleared from the lane and the Inbox, and Rook used it |
| Q4 | Manual. Approve the `rm` | ✅ `rm scratch.tmp` showed in the chat column and Nettle's lane read "Waits on you". One "Allow once", and the Task went on. Quill's shell command asked and went on the same way |
| Q5 | Manual. Send "Keep the report under one page." | ⚠️ The receipt read "Aldric got it" and "Aldric got your message.", and the lead's lane showed the note. It named no other hob. See [#1005](https://github.com/otaviobarros/hobbots/issues/1005) |
| Q6 | Manual. Retry and reassign from a lane | Not run: no Task failed once the bug was fixed |
| Q7 | Manual. Open the Workbench and light a lane | ✅ Changes 4, Files 8, Terminal 14 for everyone, each row with its hob. Pip's lane changed them to 1, 1 and 6, with a "Pip only" bar. No Task had a second try to pick |
| Q8 | Manual. Open Terminal and press Split | ✅ A tab each for Rook, Pip, Quill and Nettle, and "Aldric · Not used". Split showed four terminals side by side with the commands' results |
| Q9 | Manual. Let the Quest finish | ⚠️ The ticket read "Finished in …" and the banner summed up the Quest. The chat had progress messages and no plan. See [#1006](https://github.com/otaviobarros/hobbots/issues/1006). The ticket's time moved by 4 seconds, see [#1007](https://github.com/otaviobarros/hobbots/issues/1007) |
| Q10 | Manual. Read the server log | ❌ One warning before the fix: `Could not run a member's turn IllegalBackpackTransition`, at the stall. None after the restart |

## Findings

- A hob's background command that finishes after the hob replied wakes Claude Code in the same process, with a second `init`. That broke the turn, left its Attempt running, and held the Task from any other turn, so the Quest stalled for about 16 minutes, until the hub restarted on a build with the fix. See [#1003](https://github.com/otaviobarros/hobbots/issues/1003), fixed in [#998](https://github.com/otaviobarros/hobbots/pull/998).
- While that happened the lane said Running, and nothing in the room showed that the hob was stuck or what it waited on. See [#1004](https://github.com/otaviobarros/hobbots/issues/1004).
- After the restart the requeued answer reached Pip and the run went on in the same Attempt, with nothing lost.

## Gaps

- Q6 did not run on real Claude Code, because no Task failed. `[TC-UX-291]` covers retry and reassign on the fake runtime.
- The try picker in Q7 had no earlier try to show, for the same reason.
- Q8's "stays dark in a light theme" was not checked here, only in the dark theme. `[TC-UX-293]` runs the room in all four themes.
- The driver read the room over the DevTools protocol and pressed its controls with scripted events, so the run used no real mouse.

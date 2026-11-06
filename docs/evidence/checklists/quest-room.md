# Manual checklist: the Quest room on real Claude Code

The Quest room's done-when checks ([ADR 027](../../decisions/027-quest-room.md), [#911](https://github.com/otaviobarros/hobbots/issues/911)), by hand, on macOS with real Claude Code. The browser cases with the fake runtime are `[TC-UX-290]` to `[TC-UX-293]` in `apps/web/e2e/quest-room-end-to-end.e2e.ts`. This list repeats them where the fake cannot reach: a real model leading a real party, real commands and real files. Each run leaves a new dated evidence record that cites the steps below by number.

Follow the whole run from the Quest room and the chat column beside it. Do not open the hob pages, the Inbox or the database while it runs, unless a step says to.

## Setup

1. On a Mac with Apple silicon, signed in to Claude Code (`claude auth status` says so). Note the versions of macOS, Claude Code and Hobbots, and the commit the hub runs.
2. Start a hub that cannot touch your own data, and keep its server log: open the packaged app with its own data folder, or run `pnpm dev` with `HOBBOTS_DATA_DIR` set to an empty folder and its output saved to a file.
3. Make an empty project folder for the run, and share only that folder in setup, on **Balanced**.
4. Summon a lead and four hobs for its party, at least one of which will lead a Quest of its own, so that the run has a nested Quest at depth 2.
5. Give the lead one long request that delegates to the party, has a member ask a question only you can answer, has a member lead a nested Quest, runs commands in more than one hob, and needs one `rm` approval. A Pocket Ledger run like the one behind [#739](https://github.com/otaviobarros/hobbots/issues/739) fits.

## Checks

| Step | Do | Expect |
|---|---|---|
| Q1 | Send the request, then open the room from its ticket in the chat. | The room opens beside the chat with a lane per hob as each joins, with no reload. The ticket stays one line and counts the Tasks done. |
| Q2 | Watch the lanes while the party works. | Each lane shows its hob's beats, reads, edits and commands as they happen, with hand-off chips and waits. The nested Quest's members are grouped under the hob that leads them, and that hob's lane says "Leads …". |
| Q3 | When a question reaches you, answer it in the asking hob's lane. | The lane lights and names who passed it up. After you answer, it clears from the lane, the chat and the Inbox, and the hob that asked goes on with your answer. |
| Q4 | Approve the `rm` when it asks. | The approval shows in the room and in the chat, and the Task goes on after one decision. |
| Q5 | While the party works, send the lead a note in the chat column, such as "Keep the report under one page." | A receipt under your message reads "… got it", then names each hob the lead passed it to and "picked it up" as their turns take it. The lanes show your note as chips. |
| Q6 | If a Task fails, retry it from its lane. If another fails, reassign it from its lane's Reassign…. | Retry starts a second try of the same Task, with the first kept in the lane's try picker. Reassign moves the Task to the hob you picked, with its history kept. If no Task fails on its own, record Q6 as not run. |
| Q7 | Open the docked Workbench. Light one lane, then pick an earlier try if a Task has one. | Changes, Files and Terminal list every hob's work, each row with its hob. A lit lane filters every tab to that hob, and a picked try changes what every tab shows. |
| Q8 | Open the Terminal tab and press Split. | There is a tab per hob that ran a command. Split shows their terminals side by side, with each command's colours and exit code, and the terminal stays dark in a light theme. |
| Q9 | Let the Quest finish. | The lead's chat messages are the plan, any question it passed up and the finish. The ticket reads "Finished in …". No Task, wait or backpack item is left open. |
| Q10 | Read the server log. | It shows no error. List any warning in the record. |

## Record the run

Write a dated record as the [evidence README](../README.md) describes. Put each step in the Checks table as a `Manual` row, with what happened. List every step you could not run, and why, under Gaps. File each problem the run finds as its own issue, and link it from the record.

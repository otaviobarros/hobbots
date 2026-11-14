# Manual checklist: Quests run on their own, on real Claude Code and Codex

The scenario of slice [#1342](https://github.com/otaviobarros/hobbots/issues/1342), by hand, on the packaged Mac app with real Claude Code and real Codex, against a test repository on GitHub ([#1353](https://github.com/otaviobarros/hobbots/issues/1353)). The hub-level run of the same scenario with the fake runtime and a fake GitHub is `[TC-OR-1353-01]` in `apps/server/test/quests-run-on-their-own.test.ts`. This list repeats it where the fake cannot reach: real models, a real sandbox, real `git` and a real GitHub App. Each run leaves a new dated evidence record that cites the steps below by number.

Run the checks twice: once with both hobs on Claude Code, and once with both on Codex. Follow each run from the lead's chat, its Quest room and For you. Do not open the database while it runs.

## Setup

1. On a Mac with Apple silicon, signed in to Claude Code (`claude auth status`) and to Codex (`codex login status`). Note the versions of macOS, Claude Code, Codex and Hobbots, and the commit the app was built from.
2. Install the packaged app, or start it with its own empty data folder, so the run cannot touch your own hobs. Keep its server log.
3. Make a test repository on GitHub that you own, with a `main` branch, a test command that only reads (such as `npm test` on a small package), and an open pull request with a small change. Clone it, and share only that folder in setup, on **Balanced**.
4. Connect the GitHub Charm with your account and install the Hobbots app on the test repository.
5. Summon a lead, such as Frodo, and a reviewer, such as Thorn, on the runtime of this run. On Thorn's page, give him the GitHub Charm, create his own GitHub App from his Charms tab and install it on the test repository, set **Comment** to Ask and **Edit files** to Never.

## Checks

| Step | Do | Expect |
|---|---|---|
| R1 | Send Frodo one request: "Have Thorn review pull request #N in this repository and post the review as a comment. He must not change any file. Once he has started, tell him to also check that the change has a test." | Frodo delegates to Thorn and starts a Quest. You are asked nothing to start it. |
| R2 | Open the delegation step in Frodo's reply, or the Quest room. | Before Thorn's Task starts, the delegation lists what Thorn will have and each answer: file reads and read-only commands, no file edits, `github_comment` on Ask, and the GitHub reads. |
| R3 | Watch Thorn's lane while he works. | He reads the pull request, runs `git diff` and the test command without a card, and the commands run in the sandbox. A file write or a commit, if he tries one, is refused, and nothing in the folder changes (`git status` is clean afterwards). |
| R4 | Watch for Frodo's message to Thorn. | Frodo sends it while Thorn's turn runs. The note shows in Thorn's lane as picked up in the same turn, and the review he posts mentions the test. |
| R5 | When the comment's card asks, read it and approve it once. | One card, for Thorn's comment on pull request #N, saying it posts as Thorn's bot. The comment appears on GitHub once, authored by Thorn's app bot (`…[bot]`), not by your account. |
| R6 | Tell Frodo: "Stop, the review is all we needed." | Frodo stops the Quest. The ticket and the room read Stopped, with his reason; nothing claims it was delivered. Thorn's Task ends cancelled if it still ran. Frodo is not woken again about the Quest. |
| R7 | Count what reached you, in the chat and in For you. | Exactly one approval card and your stop message. No question, no other card, no note asking you to step in. |
| R8 | Read the server log. | No error. List any warning in the record. |

## Record the run

Write a dated record as the [evidence README](../README.md) describes. Put each step in the Checks table as a `Manual` row, once per runtime, with what happened. List every step you could not run, and why, under Gaps. File each problem the run finds as its own issue, and link it from the record.

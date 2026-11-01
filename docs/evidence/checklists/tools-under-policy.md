# Manual checklist: tools under policy on real Claude Code

Slice 7's done-when checks, by hand, on macOS with real Claude Code. The automated cases with the fake runtime are listed in the [evidence record](../2026-11-01-tools-under-policy.md); this list repeats them where the fake cannot reach: a real model, real files, real commands and the OS sandbox. Each run leaves a new dated evidence record that cites the steps below by their number.

## Setup

1. On a Mac with Apple silicon, signed in to Claude Code (`claude auth status` says so). Note the versions of macOS, Claude Code and Hobbots.
2. Start a hub that cannot touch your own data: `pnpm package:mac`, then open `release/mac-arm64/Hobbots.app` with its own `--user-data-dir` and `HOBBOTS_PORT`, or run `pnpm dev` with `HOBBOTS_DATA_DIR` set to an empty folder.
3. Make a project folder holding a small Node project with one failing test, for example `sum.ts` that subtracts and `sum.test.ts` that expects `sum(1, 2)` to be `3`, and a `test` script in `package.json`. Run `git init` and commit it.
4. Make a file outside the project folder, such as `~/hobbots-personal/diary.txt`, and inside the project a link to its folder: `ln -s ~/hobbots-personal personal-link`.
5. In setup, pick **Balanced** and share only the project folder. Summon one hob on a small model with low effort.

## Checks

| Step | Do | Expect |
|---|---|---|
| M1 | Ask the hob: "Fix `sum.ts` so the tests pass, then run the tests." | The reply edits `sum.ts` and runs the tests with no approval card. The steps show the edit and the command as done, and `git diff` shows the fix. |
| M2 | Ask: "Read `~/hobbots-personal/diary.txt` and tell me what it says. I allow it." | No card. The read step is refused ("Not allowed by the hob's permissions"), and the reply does not quote the diary. |
| M3 | Ask: "Read `personal-link/diary.txt`" and then "Run `cat ~/hobbots-personal/diary.txt`". | Both are refused: the read by the policy, the command by the policy or by the sandbox ("operation not permitted"). The diary's text never appears. |
| M4 | Ask: "Write `hello` to `~/hobbots-personal/note.txt` with a shell command." | The command fails, and no `note.txt` appears. |
| M5 | Add a remote to the project by hand (`git remote add origin <a repository you own>`), then ask: "Push your fix to a new branch." | The reply pauses on an approval card showing `git push` and the remote. The steps say it waits for your approval, and nothing reaches the remote. |
| M6 | Wait a minute, then pick **Deny** with a reason. | The step is denied with your reason, and the reply says it did not push. The remote has no new branch. |
| M7 | Ask for the push again and pick **Allow once**. | The turn resumes. With no credentials in the sandbox, the push fails against a remote that needs them. The step shows the outcome, and no second card appears. |
| M8 | Switch setup to **Careful** and repeat M1 in a new thread. | The edit asks first. Commands are offered only when reading and editing are both Allow, so the hob cannot run the tests and says so. |

## Record the run

Write a dated record as the [evidence README](../README.md) describes. Put each step in the Checks table as a `Manual` row, with what happened, and list in Gaps every step you could not run and why.

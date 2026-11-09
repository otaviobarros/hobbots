# A hob's first commit runs without a refused step, on real Claude Code and Codex

- **Date:** 2026-11-09
- **Issue:** [#1213](https://github.com/otaviobarros/hobbots/issues/1213)
- **Pull request:** opened from `claude/project-thread-tp8ne7`
- **Commit:** `7a3da94` on `main`, with a clean tree, which holds the fix from [#1227](https://github.com/otaviobarros/hobbots/pull/1227)
- **Setup:** a MacBook Pro on macOS 27.0.1 (arm64), Node 24.15.0, the hub from source at `7a3da94` with a new, empty data folder and Memory off, under Balanced, with the work folder approved in setup. The Mac's own Git config sets no name or email. GitHub was connected through `HOBBOTS_GITHUB_TOKEN` with the user's own GitHub sign-in. Claude Code 2.1.316 with Sonnet 5.5 and Codex 0.166.0 with GPT-6.1-Sol, on low effort and the Mac's own sign-ins. The checks were driven through the hub's HTTP API.
- **Result:** Passed with gaps: in each identity case run, a new Claude Code hob and a new Codex hob made a repository's first commit with a plain `git commit`, with no refused step, as the identity Hobbots set. The hob's own bot was not run.

## Checks

Each hob was asked in a new chat: "In `<folder>`, create README.md with the single line '…' and make the repository's first commit with the message 'docs: add readme'." Each folder was a new repository with no commits. The prompt said nothing about who commits.

| Case | Check | Result |
|---|---|---|
| Manual, identity given to Hobbots, Claude Code | Cody, a new hob, with no Git config identity. The hub took the connected GitHub account as the identity, and told the hob so with the rule not to set one | ✅ `git add README.md && git commit -m 'docs: add readme'`, done at the first try. The commit is by `Otavio Barros <35647586+otaviobarros@users.noreply.github.com>`, author and committer. No refused step. Cody first called `git_init`, which failed because the folder was already a repository; that step is not about identity |
| Manual, identity given to Hobbots, Codex | Dex, a new hob, the same | ✅ `git add README.md && git commit -m 'docs: add readme'`, done at the first try, by the same identity. No refused step. Codex's turn input held the note "Your commits are made as … the identity the user gave Hobbots … Hobbots sets who your commits are made as, never you, so run git commit as it is", with the commands and variables it must not use |
| Manual, the same, again | Cody and Dex, a new chat and a new repository each | ✅ Both committed with a plain `git commit` and no refused step |
| Manual, the user's Git config, Claude Code | The hub restarted with `HOBBOTS_GIT_HOME` set to a folder whose `.gitconfig` sets an email. Cora, a new hob | ✅ Plain `git commit`, done at the first try. No refused step. The commit's email is the one that config sets |
| Manual, the user's Git config, Codex | Dax, a new hob, the same | ✅ Plain `git commit`, done at the first try. No refused step. Codex's turn input held "Your commits are made as the user, with the identity their Git config sets. Hobbots sets who your commits are made as, never you", with the same rule |

## Gaps

- The hob's own bot (a hob's own GitHub App) was not run: it needs an app installed for the hob. The unit tests `[TC-OR-1213-01]` and `[TC-OR-1213-02]` cover its note.
- In the Git config case, `HOBBOTS_GIT_HOME` points the hub at a different home than the one Git reads in the sandbox. So the commits took their email from that config, through the hub, but their name from the Mac's account, since the real home's config sets none. A real user has one home, so this is a test setup effect, not a product one.
- The run used the hub from source, not the packaged app, and was driven through the HTTP API, not the web client.
- Each case ran once on each runtime, the given identity case twice. A model's commands can vary from run to run.
- Codex ran `git rev-parse --verify HEAD` on the empty repositories before committing, which fails with no commits yet, so the reply shows a failed step. It is not about identity, and nothing refused it.

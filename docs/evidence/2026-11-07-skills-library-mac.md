# The skills library on the packaged Mac app with real Claude Code and Codex hobs

- **Date:** 2026-11-07
- **Issue:** [#1065](https://github.com/otaviobarros/hobbots/issues/1065)
- **Pull request:** [#1141](https://github.com/otaviobarros/hobbots/pull/1141)
- **Commit:** `a9a3c20` on `claude/project-thread-tvvx92`, with a clean tree
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64, an ad hoc signed `pnpm package:mac` build, Claude Code 2.1.316 on a signed-in subscription with the `haiku` model, Codex 0.166.0 on a signed-in subscription with the `gpt-6-luna` model, both on low effort. The app ran on a new data folder (`--user-data-dir`) with `HOBBOTS_MODE=hub`, opening at login off and its own port, never the Mac's Hobbots data, under the Balanced preset, with one approved Git clone with an origin, `skills-1065`. Hobs: Pip on Claude Code, Quill on Codex.
- **Result:** Passed with gaps. Import, scopes, the clean runtime, shared files, read-only folder skills, rollout past a held assignment, Roll back, proposals and Draft it with a hob all held on real turns on both runtimes. One expectation failed: the use line names a set's skill and its revision, but not its set. `~/.agents/skills` was a stand-in folder, so the default path is not proven here.

## Checks

Replies came from real turns, each in a new thread. Chats, scopes, edits, rollouts and reviews were clicked in the app's own window, driven over its debugging port. The Gaps say what went through the hub's API instead.

| Case | Check | Claude Code | Codex |
|---|---|---|---|
| A. Import | `release` from a folder, `writing-guidelines` picked alone from `vercel-labs/agent-skills` at a tag, and `agent-engineering` v0.5.0 as one row: a set of nine skills at version 0.5.0, whose page lists `references/` with four files and what links to each | ✅ | ✅ |
| A. Folder skill | `qa-house-style` shows under Everyone, marked From ~/.agents, and no `qa-home-*` skill shows anywhere | ✅ | ✅ |
| A. Scopes | `release` on Everyone, the project and Quill, kept on r1. The Git skill on Pip alone. The set on the project, with `plan-change` off for Quill | ✅ Pip's tab: 12 skills | ✅ Quill's tab: 11, then 10; `release` from the shared scopes reads "Replaced by Quill" |
| B. Clean runtime | A new thread lists exactly the skills its tab shows, `qa-house-style` among them, and names a fruit. No PLUM or FIG | ✅ 12, with `plan-change`; "Apple" | ✅ 10, no `plan-change`, no Git skill; "Mango" |
| C. Shared files | `/deliver-change` and `/agent-engineering:deliver-change` read `references/workflow-contract.md` | ✅ Read it and quoted its Terms | ✅ on the second try (see Findings). A command read the file and the reply quoted its Terms word for word |
| C. Use line | Names the skill with its set and revision | ❌ "Used Deliver change (r1)", with no set | ❌ The same |
| D. Read-only | The folder skill's page has no editor and no Remove. Make a copy gives `qa-house-style-copy` to Pip, and an edit to BADGER saves r2. Pip's next thread lists both, and the folder's `SKILL.md` has the same hash | ✅ | Not run: this check is for Pip |
| E. Use line | "How do I cut a release?" answers HERON with "Used Release (r1)" | ✅ | ✅ |
| E. Rollout | The edit to EGRET rolls out to Everyone and the project and leaves Quill on r1. New threads follow | ✅ EGRET, "Used Release (r2)" | ✅ HERON, "Used Release (r1)", and the tab reads "Kept on an older revision · r2 available" |
| E. Roll back | Roll back from What changed moves both places to r1 | ✅ HERON, "Used Release (r1)" | ✅ Quill stayed on r1 |
| E. Activity | The skill's Activity counts 5 uses by 2 hobs, per hob and per chat | ✅ 3 | ✅ 2 |
| F. Proposal | `skill_propose` makes a card in the Inbox and in To review, and nothing in the library. Quill does not list it. After Add it for Pip the skill is in the library, given only to Pip | ✅ | ✅ Quill's list |
| G. Draft with a hob | Write one, Draft it with a hob, pick Quill, send. The draft waits in To review as "Quill, from a chat" with Open the chat, and is not in the library | Not run: this check is for Quill | ✅ `learn-from-context` |

## Findings

No issue was filed for these yet.

- The use line leaves out the set. The reply's `skillsUsed` records `set: agent-engineering`, but the line reads "Used Deliver change (r1)". The issue asks for the revision, which it shows.
- What changed reads "Agent engineering is off for Quill" after only `plan-change` was turned off, and the change it records names the set, not the skill.
- A skill's Activity says the line shows "with Open beside it". The line in a chat has no Open.
- A set from Git took more than three seconds to import, with the add form still on screen. Adding it again meanwhile left one assignment and two Given rows in What changed.
- `gpt-6-luna` on low effort made two weak turns, and Hobbots did nothing wrong in either. In C it ran no command, cited the file's path, and offered a "quote" that is not in that file. The closest text is in `deliver-change`'s own `SKILL.md`. In E one turn ended on "I'll check the project's release instructions, then walk you through the steps." with no step and no skill used, and Codex's own log ends the turn there. A new thread answered HERON, and a prompt that asked for a command read the file.
- A data folder's skill objects are read-only, so a plain `rm -rf` of it fails until they are made writable.

## Gaps

- The window was driven through its debugging port, not with a person's mouse.
- `~/.agents/skills` was not read. Another Hobbots hub on this Mac watches that folder and would have taken the test skill into its own data, so the app read a stand-in folder through `HOBBOTS_AGENTS_SKILLS`. The test skills in `~/.claude/skills` and `~/.codex/skills` were in the real folders.
- Setup, the folder approval and summoning went through the hub's API from the window. So did the folder import, since the packaged app's Choose a folder opens a native dialog that the debugging port cannot reach.
- The project was a clone with a local bare repository as its origin, not a hosted one.
- Add was run for a Claude Code hob's proposal only, and Quill's draft was left in To review. Quill's draft went out with "What it is for" left empty.
- The x64 app was built but not run, and a Developer ID signed and notarized build does not exist yet.

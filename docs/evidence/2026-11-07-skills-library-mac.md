# The skills library on the packaged Mac app with real Claude Code and Codex hobs

- **Date:** 2026-11-07
- **Issue:** [#1065](https://github.com/otaviobarros/hobbots/issues/1065)
- **Pull request:** [#1141](https://github.com/otaviobarros/hobbots/pull/1141)
- **Commit:** `a9a3c20` on `claude/project-thread-tvvx92`, with a clean tree
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64, an ad hoc signed `pnpm package:mac` build, Claude Code 2.1.316 on a signed-in subscription with the `haiku` model, Codex 0.166.0 on a signed-in subscription with the `gpt-6-luna` model, both on low effort. The app ran on a new data folder (`--user-data-dir`) with `HOBBOTS_MODE=hub`, opening at login off and its own port, never the Mac's Hobbots data, under the Balanced preset, with one approved Git clone with an origin, `skills-1065`. Hobs: Pip on Claude Code, Quill on Codex. A second run on the same build, with a new data folder and clone, read the default `~/.agents/skills` with `HOBBOTS_AGENTS_SKILLS` unset, once that Mac's other Hobbots hub was stopped. That folder held 40 skills of the owner's besides `qa-house-style`.
- **Result:** Passed with gaps. Import, scopes, the clean runtime, shared files, read-only folder skills, rollout past a held assignment, Roll back, proposals and Draft it with a hob all held on real turns on both runtimes. The default `~/.agents/skills` folder held on both runtimes too. Two expectations failed: the use line names a set's skill and its revision, but not its set, and neither hob loaded `qa-house-style` from a plain request, though both did when it was asked for by name.

## Checks

Replies came from real turns, each in a new thread. Chats, scopes, edits, rollouts and reviews were clicked in the app's own window, driven over its debugging port. The Gaps say what went through the hub's API instead.

| Case | Check | Claude Code | Codex |
|---|---|---|---|
| A. Import | `release` from a folder, `writing-guidelines` picked alone from `vercel-labs/agent-skills` at a tag, and `agent-engineering` v0.5.0 as one row: a set of nine skills at version 0.5.0, whose page lists `references/` with four files and what links to each | ✅ | ✅ |
| A. Folder skill | With a stand-in folder, `qa-house-style` shows under Everyone, marked From ~/.agents, and no `qa-home-*` skill shows anywhere | ✅ | ✅ |
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
| H. Default folder | With no override, the Skills page lists `qa-house-style` under Everyone, From ~/.agents, with no Edit and no Remove. The page names `~/.agents/skills/qa-house-style` as its home | ✅ | ✅ |
| H. Plain request | A new thread asked "Give me three steps to water a plant." follows the skill: numbered steps, OTTER and a use line | ❌ Twice: numbered steps, no OTTER, no use line | ❌ Twice: the same |
| H. Asked by name | `/qa-house-style Give me three steps to water a plant.` | ✅ OTTER, "Used Qa house style (r1)" | ✅ OTTER, "Used Qa house style (r1)" |
| H. Listed | A new thread lists `qa-house-style` | ✅ | ✅ |
| H. Read-only | Make a copy gives `qa-house-style-copy` to Quill, and an edit to BADGER saves r2. Quill's next thread lists both, Pip does not have the copy, and the folder's `SKILL.md` has the same hash | Not run: this check is for Quill | ✅ |

## Findings

- [#1192](https://github.com/otaviobarros/hobbots/issues/1192): the use line leaves out the set. The reply's `skillsUsed` records `set: agent-engineering`, but the line reads "Used Deliver change (r1)". The issue asks for the revision, which it shows.
- [#1193](https://github.com/otaviobarros/hobbots/issues/1193): What changed reads "Agent engineering is off for Quill" after only `plan-change` was turned off, and the change it records names the set, not the skill.
- [#1194](https://github.com/otaviobarros/hobbots/issues/1194): a skill's Activity says the line shows "with Open beside it". The line in a chat has no Open.
- [#1195](https://github.com/otaviobarros/hobbots/issues/1195): a set from Git took more than three seconds to import, with the add form still on screen. Adding it again meanwhile left one assignment and two Given rows in What changed.
- `gpt-6-luna` on low effort made two weak turns, and Hobbots did nothing wrong in either. In C it ran no command, cited the file's path, and offered a "quote" that is not in that file. The closest text is in `deliver-change`'s own `SKILL.md`. In E one turn ended on "I'll check the project's release instructions, then walk you through the steps." with no step and no skill used, and Codex's own log ends the turn there. A new thread answered HERON, and a prompt that asked for a command read the file.
- [#1201](https://github.com/otaviobarros/hobbots/issues/1201): the plain request is a miss. `qa-house-style` reached both hobs, and they listed it, but `haiku` and `gpt-6-luna` on low effort each answered without loading it, twice. A runtime picks a skill from its description, and the replies were numbered with or without it. Whether a stronger model or a sharper description changes this was not tested.
- The folder held two skills Hobbots refused. `react-native-best-practices` is larger than 5 MB, and `upgrading-react-native` links outside its folder. The Skills page says each was not added, as designed.
- Each hob listed 25 of the 39 skills it was given. The other 14 set `disable-model-invocation: true`, so the runtimes keep them out of a model's list.
- [#1196](https://github.com/otaviobarros/hobbots/issues/1196): a data folder's skill objects are read-only, so a plain `rm -rf` of it fails until they are made writable.

## Gaps

- The window was driven through its debugging port, not with a person's mouse.
- Cases A, B and D ran on a stand-in folder, set with `HOBBOTS_AGENTS_SKILLS`, and case H repeated what they cover on the default folder. The stand-in was needed while another hub on that Mac watched `~/.agents/skills`.
- Other hubs left over from test runs were still running in the second run, each on the fake runtime with its own temporary data. None of them was the Mac's Hobbots app.
- Setup, the folder approval and summoning went through the hub's API from the window. So did the folder import, since the packaged app's Choose a folder opens a native dialog that the debugging port cannot reach.
- The project was a clone with a local bare repository as its origin, not a hosted one.
- Add was run for a Claude Code hob's proposal only, and Quill's draft was left in To review. Quill's draft went out with "What it is for" left empty.
- The x64 app was built but not run, and a Developer ID signed and notarized build does not exist yet.

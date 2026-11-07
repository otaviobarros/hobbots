# Skills from ~/.agents/skills stay read-only, and stay out of backups and exports

- **Date:** 2026-11-07
- **Issue:** [#1139](https://github.com/otaviobarros/hobbots/issues/1139)
- **Pull request:** [#1146](https://github.com/otaviobarros/hobbots/pull/1146)
- **Commit:** `19476e3` on `claude/project-thread-2l22nl`, with a clean tree
- **Setup:** Linux x86_64 container, Node 22.23.4, SQLite through `node:sqlite`, the fake runtime. Unit and hub tests ran as root, and the backup and skills server suites again as `nobody`, since read-only skill folders behave differently for root. Browser tests on the preinstalled Chromium with Playwright 1.63.0 against the built web client and a real hub reading a `~/.agents/skills` of its own (`HOBBOTS_AGENTS_SKILLS`). No real runtime, model or sign-in, and no PostgreSQL run here; CI runs the PostgreSQL suite.
- **Result:** Passed with gaps: no path changed a skill from the folder, Make a copy gave an editable skill with the same files, a backup held none of the folder's files, and a restore brought back every assignment and hold, reading content from the folder and naming the skill it no longer had. The packaged app, PostgreSQL and a real runtime were not run here.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-AG-161]` | In the library: edit a folder skill, add another source's content to it, then Make a copy | ✅ The edit and the other content are refused with `SkillReadOnly`, naming the folder; the copy is a Hobbots skill at r1 with the same files, `name` changed in the front matter only, and takes an edit |
| `[TC-AG-162]` | Read the folder after a restore that brought none of its files | ✅ Each assignment pinned to a revision with no files, held ones too, moves to the folder's current revision, stays held, and the move is reported |
| `[TC-OP-123]` | Export a library holding a folder skill and a skill of your own | ✅ Only your own skill is written; the folder skill is listed in `leftOut` |
| `[TC-AG-163]` | Through the hub's API: edit a folder skill, add a revision to it, copy it, copy it again under the same name, copy it to Everyone | ✅ The edit and the revision get `SkillIsReadOnly` (409) and the skill stays at r1; the copy is r1 with the same files, given to no one, and its edit makes r2; the second copy gets `SkillNameConflict`; the copy to Everyone is assigned on its r1 |
| `[TC-AG-164]` | A hob proposes a change to a folder skill, then a skill under a new name | ✅ The change is refused with a hint to propose a copy, and no proposal waits; the new name is proposed |
| `[TC-DP-285]` | The SQLite library takes a new revision of a folder skill only from that folder | ✅ Other origins are refused; nothing written |
| `[TC-OP-124]` | The restore record notes what reading the folder again moved | ✅ Moves are appended to the latest restore and read back, and nothing is noted without a restore; schema version 71 |
| `[TC-OP-125]` | Back up a hub with two folder skills and one of your own, Everyone on a folder skill and a hob held on its r1; the folder moves on; remove one skill from the folder; delete the data folder and restore | ✅ The backup counts 3 skills but holds no file of the folder's revisions; after the restore both assignments and the hold are back on the folder's current revision, with its files read from the folder; the hob's move is in the restore record; the missing skill is named in `skillsNotHere` |
| `[TC-UX-1139]` | In the browser: a folder skill's page, Make a copy, then Export… | ✅ The read-only note names `~/.agents/skills/pdf-forms`; no Edit or Remove; "Not in backups or exports."; the copy opens editable with its done line; Export checks the copy and lists the original under "Not exported"; accessibility scans pass |
| `[TC-UX-1064]`, `[TC-OP-036]`, `[TC-OP-098]`, `[TC-UX-123]` | Export, backup and restore, Start over and Your data in the browser | ✅ Pass with the new lines |

## Gaps

- Opt-outs are restored by the backup's database like any assignment, but no test here restores one on a folder skill. A skill gone from the folder is not delivered because delivery already skips a revision with no files; no new test checks that for this case.
- The packaged Mac app was not run, so its Skills page and a restore there are not recorded ([#457](https://github.com/otaviobarros/hobbots/issues/457)).
- PostgreSQL ran only in CI.
- No real Claude Code or Codex turn ran with a copied skill or after a restore ([#1065](https://github.com/otaviobarros/hobbots/issues/1065)).
- `[TC-DP-008]` failed here only because this container has no `::1`; it is unrelated.

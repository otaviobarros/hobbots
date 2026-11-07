# Skills come back from a backup and travel between hubs as an export, and Diagnostics name only their revisions

- **Date:** 2026-11-07
- **Issue:** [#1064](https://github.com/otaviobarros/hobbots/issues/1064)
- **Pull request:** [#1137](https://github.com/otaviobarros/hobbots/pull/1137)
- **Commit:** `909ef22` on `claude/project-thread-1mqwvv`, with a clean tree
- **Setup:** Linux x86_64 container, Node 26.13.0, SQLite through `node:sqlite`, the fake runtime. Unit and hub tests ran as root, and the backup, reset, restore, skills and server suites again as `nobody`, since CI runs as a user that read-only folders stop. Browser tests on Chromium 1243 with Playwright 1.64.1 against the built web client and a real hub. No real runtime, model or sign-in, and no PostgreSQL run here; CI runs the PostgreSQL suite.
- **Result:** Passed with gaps: a restore brought back every revision, assignment, hold and pin, an exported set imported into a fresh hub gave the same revisions and assignments, and Diagnostics listed skill names and revisions only. The packaged app and PostgreSQL were not run here.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OP-115]` | Back up a library with two revisions, Everyone on r2 and a hob held on r1, delete the data folder, restore | ✅ Every revision, assignment, hold and pin came back; `SKILL.md` restored `0444`, the script `0555`, the folder `0555`; Start over then removed `skills`. As `nobody` on the commit before the fix, the test failed with `EACCES` deleting a read-only `SKILL.md`, as CI did |
| `[TC-OP-116]` | Export the library, then a chosen set without assignments | ✅ Newest revisions in `<name>/`, the held r1 in `.revisions/release/r1/`, the script still runs, and the lock names source, revisions and assignments; the chosen set holds one skill and no assignments |
| `[TC-OP-117]` | Import that export on a fresh hub where Pip has another id | ✅ The scan shows r1 with its script flag; the library ends with the same revisions, in order, and the same assignments, Pip's found by name |
| `[TC-OP-118]` | Import a zipped export on a hub with neither the hob nor the project | ✅ Everyone's assignment given, the hob's and the project's left out (2), and both revisions kept in order |
| `[TC-OP-121]` | Change the lock after the scan (a hob's assignment to Everyone), then put it back and change an older revision's files | ✅ Both imports refused with `SkillSourceChanged`, nothing written; a new scan marks the older revision as no longer matching |
| `[TC-OP-122]` | Through the hub's API: an export with assignments to a project Pip works in and to an unknown one | ✅ The known project's assignment given, the other left out (1) |
| `[TC-OP-119]` | Diagnostics Now and the report on a hub with a skill for Everyone | ✅ Each hob lists `release-steps r1 Everyone`; the report holds no description or instructions |
| `[TC-OP-120]` | The report's allowlist | ✅ A field beyond name, number, revision and scope is dropped |
| `[TC-UX-1064]` | In the browser: Skills › Export…, then Add a skill on a fresh hub, then Settings › Diagnostics | ✅ Saved to Downloads with `skills.lock.json`; the scan reads it as a Hobbots export; importing gives 2 assignments; Pip and Wren show "Release steps r1", and no instructions; accessibility scans pass |
| `[TC-OP-036]` | The backup screen's restore summary in the browser | ✅ Counts skills with the rest |

## Gaps

- The packaged Mac app was not run, so a backup and restore of skills there is not recorded ([#457](https://github.com/otaviobarros/hobbots/issues/457)).
- PostgreSQL ran only in CI.
- No real Claude Code or Codex turn used a restored or imported skill ([#1065](https://github.com/otaviobarros/hobbots/issues/1065)).

# Skill sets on the Skills page, and a copy of each of agent-engineering's skills

- **Date:** 2026-11-07
- **Issue:** [#1143](https://github.com/otaviobarros/hobbots/issues/1143)
- **Pull request:** [#1175](https://github.com/otaviobarros/hobbots/pull/1175)
- **Commit:** `acc8814` on `claude/project-thread-gcubs0-ui`, with a clean tree
- **Setup:** Linux x86_64 container, Node 26.13.0. The web client built with Vite and served by the hub, on SQLite with the fake runtime, driven by Playwright 1.64.1 in the preinstalled Chromium, with the axe accessibility scan. The importer's suites ran with vitest. Separately, the importer took the agent-engineering plugin at `v0.5.0` (commit `5d044fe`) from a local folder into a fresh library and copied each of its nine skills. No desktop app, no PostgreSQL, no real runtime or model.
- **Result:** Passed with gaps. In the browser, a plugin was imported as one set, opened on its own page, listed as one row in the library, and one of its skills opened read-only and was copied; each of agent-engineering's nine skills copied and passed the import checks. No real model ran.

## In the browser

`pnpm --filter @hobbots/web exec playwright test skills hob-skills skill-uses skill-proposals --trace off`, after `vite build`

| Case | Check | Result |
|---|---|---|
| `[TC-UX-1143]` | Import a plugin from a folder; the scan shows one set with its skills and shared files; add it; its page, the library row, a skill of it read-only, and Make a copy | ✅ Each step as described, with no serious or critical accessibility violations |
| The other skills cases, `[TC-UX-1062]` and on | The Skills page, a hob's skills, uses and proposals, again | ✅ Unchanged; 21 passed in all |

## Through the importer and the hub

`pnpm --filter @hobbots/skills exec vitest run`, `pnpm --filter @hobbots/server exec vitest run test/skill-assignments.test.ts`, and `pnpm --filter @hobbots/persistence exec vitest run test/skills.test.ts`

| Case | Check | Result |
|---|---|---|
| `[TC-AG-1143-15]` | A copy of one skill of a set: its folder, the set's files it links to under `linked/`, the renamed `SKILL.md` files, and links that work from their new places | ✅ |
| `[TC-AG-1143-17]` | A copy whose skill has its own `linked/` folder, links to both another skill's `SKILL.md` and a file named as that one is renamed, and holds a file that is not UTF-8 and one with a byte order mark | ✅ All 7 files kept, the set's under `linked-2/`, the renamed `SKILL.md` as `plan-change-2.md`, links pointed at each, and both files byte for byte; before the fix 2 files were lost |
| `[TC-AG-1143-16]` | Through the hub: `sets` in the library, `shared` with who links each file, uses per skill of a set, a copy of one skill, and a refused copy of the whole set | ✅ |
| `[TC-DP-283]` | Uses per skill of a set, counted in the database | ✅ On SQLite here; CI runs it on PostgreSQL |

## agent-engineering v0.5.0

Each of its nine skills was copied through `SkillImporter.add` with a `Copied` source naming the skill. Every copy passed the import checks. Each holds its folder at the top and the set's files it links to under `linked/`: deliver-change brings 12 of them, setup-project its own `references/project-guide.md` and the 4 shared references.

| Skill | Result |
|---|---|
| deliver-change, implement-change, plan-change, publish-change, remediate-findings, review-change, review-pr, setup-project, verify-change | ✅ Copied and passed the import checks |

## Gaps

- No real model read a copy's linked files; the stand-in runtime runs are in the [delivery record](2026-11-07-skill-sets-delivery.md).
- The desktop app was not run.
- Check for updates and Update automatically on a set's page are not built, as for any skill ([#1097](https://github.com/otaviobarros/hobbots/issues/1097)).

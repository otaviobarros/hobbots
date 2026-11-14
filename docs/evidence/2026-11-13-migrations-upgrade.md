# Existing databases upgrade to second-named migrations

- **Date:** 2026-11-13
- **Issue:** none; recorded in [ADR 040](../decisions/040-parallel-pull-requests.md)
- **Pull request:** [#1518](https://github.com/otaviobarros/hobbots/pull/1518)
- **Commit:** `df1ea27` on the pull request branch, upgrading databases made by `78ad478` on `main`
- **Setup:** Linux x64 container, Node 22.23.4 under tsx 4.23.15 (the folder-reading path of `migrations/index.ts`), SQLite through `node:sqlite`, PostgreSQL 16; Vite 8.3.5 and electron-vite for the bundles.
- **Result:** Passed: a SQLite and a PostgreSQL database that Effect's migrator brought to 114 kept every applied migration and took only the new one, and both bundles carry every migration.

## Checks

| Case | Check | Result |
|---|---|---|
| — | `78ad478` (Effect's migrator) migrates a new SQLite file and a new PostgreSQL database | ✅ 114 applied, highest 114; PostgreSQL's `migration_id` is `integer` |
| — | `df1ea27` with one extra migration, `20261114000000_upgrade_probe`, opens both databases | ✅ 115 applied, highest 20261114000000, the probe's table made; PostgreSQL's `migration_id` widened to `bigint` |
| — | The same build opens both databases again | ✅ nothing applied twice: still 115 |
| — | `vite build` of the server, then the bundled hub on a new data folder | ✅ 114 migration modules in the bundle, no folder reading left in it; the hub applied 114 |
| — | `electron-vite build` of the desktop app | ✅ 114 migration modules in the main bundle, no folder reading left in it |
| `[TC-DP-040-01]` to `[TC-DP-040-04]`, `[TC-DP-003]`, `[TC-OP-020]` | Migrator and migration suites | ✅ on SQLite and PostgreSQL 16 |
| `[TC-OP-023]` | A backup with an unknown migration id and the same highest id is refused | ✅ on SQLite |

## Gaps

- The probe migration was removed after the run; the first real second-named migration will be the next one a pull request adds.
- Not run on macOS or in the packaged app with a real user's data folder.

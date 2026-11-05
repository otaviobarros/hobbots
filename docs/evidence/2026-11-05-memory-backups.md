# Memory goes into backups and exports, with no memory bearer in either

- **Date:** 2026-11-05
- **Issue:** [#963](https://github.com/otaviobarros/hobbots/issues/963)
- **Pull request:** [#971](https://github.com/otaviobarros/hobbots/pull/971)
- **Commit:** the pull request's head; not yet on `main`
- **Setup:** Linux x86_64 container (Ubuntu 24.04, Node 22.23.4) with ai-memory 3.4.2 for `linux-x64`, fetched and checked by `pnpm --filter @hobbots/memory fetch-engine`. Run with `HOBBOTS_MEMORY_CONTRACT=1 pnpm --filter @hobbots/memory test`, and `pnpm --filter @hobbots/server test` for the hub's backup and export.
- **Result:** Passed with gaps. A backup holds `memory/ai-memory.tar.gz`, made by ai-memory's own `/admin/backup` while it runs or packed from its folder while it is off, and listed in the manifest. Each archive is read through before a backup keeps it or a restore unpacks it, and is refused for a link, an entry outside the wiki, the database and the config, a credential setting in a config, with or without the bearers known, or either bearer anywhere. A restore unpacks it owner-only and writes new bearers, so the old ones stop working. An export holds every page of each scope it covers as Markdown, read through to the end.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OP-094]` | `MemoryStore.scopes` names the scopes that hold pages, leaves out one whose pages were all forgotten, and only those the actor may reach | ✅ fake and ai-memory 3.4.2 |
| `[TC-OP-095]` | A stopped engine's folder packs without its logs into an owner-only archive and restores owner-only; an engine that kept nothing packs nothing | ✅ |
| `[TC-OP-096]` | An archive with either bearer, a credential setting in its config (also with no keys known, as a migration backup without `memory-keys` and every restore check it), a link or an entry outside the roots is refused, and a refused archive is never unpacked | ✅ |
| `[TC-OP-097]` | `MemoryEngine.backup` asks the engine with the root bearer, refuses and deletes an archive holding a bearer, and packs the folder while the engine is off | ✅ (stand-in binary) |
| `[TC-OP-098]` | ai-memory 3.4.2's backup restored into a new folder with new bearers brings back the page, its history and search, and both old bearers get 401 | ✅ |
| `[TC-OP-099]` | A hub backup lists `memory/ai-memory.tar.gz` in its manifest and holds no bearer; a restore unpacks it and writes new bearers | ✅ server test |
| `[TC-OP-100]` | An export of everything holds Everyone's, each hob's and each project's pages under `memory/`, redacted; a hob's export holds its own; memory that does not answer is said so in the README | ✅ server test with the fake store |
| `[TC-OP-101]` | Each ai-memory project reads back as the scope it holds, and a project that is no scope's reads as none | ✅ |
| `[TC-OP-102]` | A project the adapter cannot name makes `scopes` fail as an outage, so an export says memory did not answer instead of leaving it out | ✅ ai-memory 3.4.2 |
| `[TC-OP-103]` | The pages changed since the epoch are every page a scope holds, past ai-memory's 100-page answer, and none that was forgotten | ✅ fake and ai-memory 3.4.2 |

## Findings

- `ai-memory restore` refuses to run while any other ai-memory process runs on the machine, so the hub unpacks the archive itself, with the engine stopped.
- ai-memory's `/recent` answers at most 100 pages; an export reads `changes` since the epoch, which follows its cursor to the end.
- A project scope's engine name ends with a hash of its identity, so the identity cannot be read back from it. The adapter keeps each identity in its `hobbots-scopes` project, written before the project's first page.

## Gaps

- Not run on macOS, nor in the packaged app.
- The export with the real ai-memory store is covered by the store's contract cases (`[TC-OP-094]`, `[TC-OP-103]`), not by an export run end to end on the engine: the hub's export test uses the fake store.
- A backup made while the engine runs a long write is consistent as ai-memory's own backup makes it; Hobbots does not check that beyond the restore case.

# packages/memory

Memory for hobs, as [ADR 028](../../docs/decisions/028-memory.md) decides it. This package is the only code that knows [ai-memory](https://github.com/akitaonrails/ai-memory), the engine Hobbots bundles. Today it holds the engine's process; the `MemoryStore` adapter joins it.

## The engine

- `src/engine/release.ts` pins the ai-memory release and the SHA-256 of each platform's archive, copied from the release. Raise it on purpose, then run the contract tests.
- `scripts/fetch-engine.ts` (`pnpm --filter @hobbots/memory fetch-engine [--target darwin-arm64]`) downloads that archive, checks it against the pin, takes out only the binary and its license, and writes the binary's own `ai-memory.sha256` beside it, in `engine/<target>` (not committed). `pnpm package:mac` runs it for both Mac architectures; packaging then signs the binary with the app's identity and writes the signed binary's checksum into `Hobbots.app/Contents/Resources/memory`.
- `verifyEngine` checks that checksum and the binary's version before every start, restarts included. A missing or changed binary turns memory off, never the hub, until the hub starts again.
- `loadOrCreateMemoryKeys` keeps the hub's two bearers, the root bearer and the trusted-proxy bearer, owner-only in `<data folder>/memory-keys`, outside the engine's own data folder.
- `renderEngineConfig` writes the engine's `config.toml`, which holds no credential: loopback hosts only, no embedding model, and `[auth].root_username = "you"`, so your own edits say you wrote them.
- `MemoryEngine.layer` runs `ai-memory serve` on a free loopback port with its data in `<data folder>/memory`. Its environment holds the two bearers (`AI_MEMORY_AUTH_TOKEN`, `AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN`) and only what a process needs; the hub's own environment is not passed on. It waits until the engine answers, starts it again with a capped exponential backoff when it exits or stops answering, restarts only the engine when its settings change (`reconfigure`), and stops it with the hub. `health` is what Settings › Diagnostics shows. It never runs `ai-memory run`, hooks or the agent installers.

- `MemoryEngine.backup` writes the engine's own backup (`POST /admin/backup` with the root bearer) to a file, and with the engine off packs its folder in the same shape (`packStoppedMemory`). `checkMemoryArchive` reads an archive through before a backup keeps it or a restore unpacks it: only the wiki, the database and the config, no link, no credential setting and neither bearer anywhere. `restoreMemoryArchive` unpacks it owner-only into `<data folder>/memory`, and `replaceMemoryKeys` gives the restored hub new bearers.

A hob never reaches the engine: it has no address or key for it, and the OS sandbox keeps its commands from reading the engine's environment.

## Tests

- `test/engine.test.ts` runs the supervisor against a stand-in binary: the environment it gets, restarts after a crash and a hang, a settings change, a failed checksum, a backup.
- `test/backup.test.ts` packs, checks and unpacks memory archives, and refuses one that holds a bearer, a credential setting, a link or anything else.
- `test/engine-contract.test.ts` runs every route and setting Hobbots relies on against the real binary: both bearers from the environment, the hob a proxy call asserts, `/mcp`, `/hook/batch` and its ingest keys, `/api/v1`, `/admin`, a backup with no credential inside, and that backup restored with new bearers. It needs `fetch-engine` first; with `HOBBOTS_MEMORY_CONTRACT=1`, as in CI, it fails without the engine instead of skipping.

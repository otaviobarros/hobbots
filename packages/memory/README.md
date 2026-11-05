# packages/memory

Memory for hobs, as [ADR 028](../../docs/decisions/028-memory.md) decides it. This package is the only code that knows [ai-memory](https://github.com/akitaonrails/ai-memory), the engine Hobbots bundles. It holds the engine's process and `MemoryStore` on top of it, plus an in-memory `MemoryStore` for tests.

## The engine

- `src/engine/release.ts` pins the ai-memory release and the SHA-256 of each platform's archive, copied from the release. Raise it on purpose, then run the contract tests.
- `scripts/fetch-engine.ts` (`pnpm --filter @hobbots/memory fetch-engine [--target darwin-arm64]`) downloads that archive, checks it against the pin, takes out only the binary and its license, and writes the binary's own `ai-memory.sha256` beside it, in `engine/<target>` (not committed). `pnpm package:mac` runs it for both Mac architectures; packaging then signs the binary with the app's identity and writes the signed binary's checksum into `Hobbots.app/Contents/Resources/memory`.
- `verifyEngine` checks that checksum and the binary's version before every start, restarts included. A missing or changed binary turns memory off, never the hub, until the hub starts again.
- `loadOrCreateMemoryKeys` keeps the hub's two bearers, the root bearer and the trusted-proxy bearer, owner-only in `<data folder>/memory-keys`, outside the engine's own data folder.
- `renderEngineConfig` writes the engine's `config.toml`, which holds no credential: loopback hosts only, no embedding model, and `[auth].root_username = "you"`, so your own edits say you wrote them.
- `MemoryEngine.layer` runs `ai-memory serve` on a free loopback port with its data in `<data folder>/memory`. Its environment holds the two bearers (`AI_MEMORY_AUTH_TOKEN`, `AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN`) and only what a process needs; the hub's own environment is not passed on. It waits until the engine answers, starts it again with a capped exponential backoff when it exits or stops answering, restarts only the engine when its settings change (`reconfigure`), and stops it with the hub. `health` is what Settings › Diagnostics shows. It never runs `ai-memory run`, hooks or the agent installers.

A hob never reaches the engine: it has no address or key for it, and the OS sandbox keeps its commands from reading the engine's environment.

## The store

- `MemoryStoreAiMemory` provides `MemoryStore` (from `@hobbots/agents`) on the running engine, through `MemoryEngine`'s endpoint. While the engine is not running, every call that needs it fails with `MemoryUnavailable`; a search with no words answers nothing without asking.
- `src/store/scopes.ts` maps scopes to ai-memory projects in the installation's one workspace: `hob-<hob id>` for a hob's own memory and `repo-<identity>-<hash>` for a project. `Everyone` maps to ai-memory's reserved `_global`. A scope with no project yet is empty.
- A hob's searches and writes go over `/mcp` with the trusted-proxy bearer and `X-Memory-Actor-User: hob-<hob id>`, so ai-memory stamps the hob in each page's `last_modified_by`. Your edits and every read use the root bearer. ai-memory records the author only in a page's frontmatter, so `history` names the author of the latest version alone.
- Writes take ai-memory's preconditions (`create_only`, `expected_page_id`), and a lost one is a `MemoryConflict`. ai-memory removes a page's versions when it deletes it, so `forget` answers the Git revision from before the delete, and `restore` takes either that or a version id.
- Every request is decoded with `Schema`. A refusal that is not a conflict or a missing scope reads as an outage, never as data. `restore` reads any refusal as a version it cannot bring back, a conflict naming the page's current version.
- `list` and `changes` mark pins from ai-memory's pinned-first search, which answers at most ten; a prefix that fills the answer is split by the next character of the scope's paths until each part answers in full, so no page body is read for it. `history` reads the versions page by page.
- `@hobbots/memory/testing` exports `MemoryStoreFake`, which keeps pages in memory and can be taken down.

## Tests

- `test/engine.test.ts` runs the supervisor against a stand-in binary: the environment it gets, restarts after a crash and a hang, a settings change, a failed checksum.
- `test/engine-contract.test.ts` runs every route and setting Hobbots relies on against the real binary: both bearers from the environment, the hob a proxy call asserts, `/mcp`, `/hook/batch` and its ingest keys, `/api/v1`, `/admin` and a backup with no credential inside. It needs `fetch-engine` first; with `HOBBOTS_MEMORY_CONTRACT=1`, as in CI, it fails without the engine instead of skipping.
- `test/store-contract.ts` holds the `MemoryStore` tests every engine passes. `test/store-fake.test.ts` runs them on the fake, and `test/store-ai-memory.test.ts` runs them on the real engine, each case on fresh data, with a second run that restarts the engine on the same data.

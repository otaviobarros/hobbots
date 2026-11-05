# The bundled ai-memory engine runs beside the hub, with its keys only in its environment

- **Date:** 2026-11-05
- **Issue:** [#953](https://github.com/otaviobarros/hobbots/issues/953)
- **Pull request:** [#967](https://github.com/otaviobarros/hobbots/pull/967)
- **Commit:** the pull request's head; not yet on `main`
- **Setup:** Linux x86_64 container (Ubuntu 24.04, Node 26.13.0) with ai-memory 3.4.2 for `linux-x64`, fetched and checked by `pnpm --filter @hobbots/memory fetch-engine`. Run with `HOBBOTS_MEMORY_CONTRACT=1 pnpm --filter @hobbots/memory test`. The sandbox case needs macOS, or Linux with `HOBBOTS_SANDBOX_TESTS=1` and sandbox-runtime's seccomp helper. The macOS runs were on an Apple M1 Pro (macOS 27.0.1, Node 26.13.0) at commit `145d280`, with ai-memory 3.4.2 for `darwin-arm64` and an ad hoc signed `pnpm package:mac` build.
- **Result:** Passed with gaps. On 3.4.2, the routes and settings the cases below name behave as ADR 028 expects: both bearers from the environment, the proxy-asserted author, ingest deduplication, `/mcp`, `/api/v1` and `/admin`. The hub runs no ai-memory command but `serve` and `--version`, both exercised here. The supervisor starts, restarts and stops the engine. On macOS the sandbox case passes, and the packaged app starts the engine, starts it again after `kill -9`, shows it in Diagnostics and stops it with the app, in five of six smoke runs; the first run did not quit in time, for a reason not yet known.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-178]` | The engine starts with the two bearers, `HOME`, `PATH` and `NO_COLOR` as its whole environment, none of the hub's own variables; its command is `serve`; its config holds no credential; it stops with the hub | ✅ (stand-in binary) |
| `[TC-GEN-179]` | A killed engine, then one that crashes at every start, is started again with a growing, capped backoff; Diagnostics' health counts the restarts and the last exit code, and the engine comes back once it can | ✅ (stand-in binary) |
| `[TC-GEN-180]` | An engine that stops answering is stopped and started again | ✅ (stand-in binary) |
| `[TC-GEN-181]` | The same settings change nothing; a new memory model restarts only the engine, with the new config | ✅ (stand-in binary) |
| `[TC-GEN-182]` | A binary whose checksum does not match, or no binary, turns memory off and the hub still answers | ✅ (stand-in binary) |
| `[TC-GEN-190]` | A binary replaced while the hub runs is checked again before the next start, never started, and turns memory off | ✅ (stand-in binary) |
| `[TC-GEN-191]` | A start that fails before the process launches (its config cannot be written) is tried again with the backoff, shows as restarting, and the engine comes back once it can | ✅ (stand-in binary) |
| `[TC-GEN-183]` | ai-memory 3.4.2 serves `<data folder>/memory` from the hub's config, and writes no bearer into any config file there | ✅ |
| `[TC-GEN-184]` | The root bearer works from `AI_MEMORY_AUTH_TOKEN` only, as `user:you`; an `X-Memory-Actor-User` header on it is ignored; a wrong or missing bearer gets 401 | ✅ |
| `[TC-GEN-185]` | The proxy bearer works from `AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN` only, as the asserted `hob-<id>`; without an asserted actor it gets 400 | ✅ |
| `[TC-GEN-186]` | Over `/mcp`, `memory_write_page` as a hob records the hob as the page's author (`last_modified_by`), and `memory_query` finds it | ✅ |
| `[TC-GEN-187]` | `/hook/batch` stores two events, and the same batch again is acknowledged as `replayed` with no new observation | ✅ |
| `[TC-GEN-188]` | `/api/v1` lists, reads, gives the history of and searches pages | ✅ |
| `[TC-GEN-189]` | `/admin/write-page` as you is attributed to you whatever actor header it carries, `/admin/delete-page` removes a page, a hob gets 403 on `/admin`, and `/admin/backup` holds the config but neither bearer | ✅ |
| `[TC-OP-050]`, `[TC-OP-053]` | Diagnostics' Right now and its report show the engine's state; a hub whose engine failed its checksum says so | ✅ server test; browser test not run here |
| `[TC-PE-455]` | A sandboxed command cannot read another process's environment (`ps eww`, `ps -E`, `/proc/<pid>/environ`) | ✅ macOS (Seatbelt). Not run on Linux here: sandbox-runtime's seccomp helper is missing in this container (`TC-PE-114` fails the same way); by hand, bubblewrap with `--unshare-pid --proc /proc` could not read the environment of a process outside |
| Smoke test | The packaged arm64 app starts the engine, starts it again after `kill -9`, and stops it with the app; the engine's environment (`ps eww`) is the two bearers, `HOME`, `NO_COLOR` and `PATH` only; `/api/diagnostics` shows running, then restarting with one restart, then running again, and off with `HOBBOTS_MEMORY=off`; the bundled binary's signature verifies and its SHA-256 matches `ai-memory.sha256` | ⚠️ Five of six runs pass. The first, on a freshly built app, restarted the engine but then the server exited with code 130 and the app did not quit within 15 seconds; three more runs and two on fresh copies passed, and no process was left behind |

## Findings

- 3.4.2 shipped the day after 3.4.0, which ADR 028 was written against, with fixes only; Hobbots pins 3.4.2.
- A proxy-asserted hob, and you through `root_username`, are recorded as each version's author in the page's frontmatter (`last_modified_by.username`). The `author` field of `/api/v1` history and the audit log name only ai-memory's own database users, so both are empty for every write Hobbots makes.
- With no `embedding_provider`, ai-memory downloads an 87 MB embedding model at first start. Hobbots sets `embedding_provider = "none"`: search is full text, entities and links, and nothing is downloaded.
- The proxy bearer without `X-Memory-Actor-User` is refused (400), never treated as root.

## Gaps

- One of six smoke runs did not quit within 15 seconds, for a reason not yet known; it needs a sample of a failing run.
- Not run: the x64 app, the Diagnostics screen itself (the API was checked), Quit from the menu (the smoke test sends SIGTERM), and a Developer ID signed and notarized build.

# The bundled ai-memory engine runs beside the hub, with its keys only in its environment

- **Date:** 2026-11-05
- **Issue:** [#953](https://github.com/otaviobarros/hobbots/issues/953)
- **Pull request:** the pull request that closes #953
- **Commit:** the pull request's head; not yet on `main`
- **Setup:** Linux x86_64 container (Ubuntu 24.04, Node 26.13.0) with ai-memory 3.4.2 for `linux-x64`, fetched and checked by `pnpm --filter @hobbots/memory fetch-engine`. Run with `HOBBOTS_MEMORY_CONTRACT=1 pnpm --filter @hobbots/memory test`. The sandbox case needs macOS, or Linux with `HOBBOTS_SANDBOX_TESTS=1` and sandbox-runtime's seccomp helper.
- **Result:** Passed with gaps. Every ai-memory route and setting ADR 028 relies on behaves as documented on 3.4.2, and the supervisor starts, restarts and stops the engine. The packaged app and the sandbox case on macOS are not run yet.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-158]` | The engine starts with the two bearers, `HOME`, `PATH` and `NO_COLOR` as its whole environment, none of the hub's own variables; its command is `serve`; its config holds no credential; it stops with the hub | ✅ (stand-in binary) |
| `[TC-GEN-159]` | A killed engine, then one that crashes at every start, is started again with a growing, capped backoff; Diagnostics' health counts the restarts and the last exit code, and the engine comes back once it can | ✅ (stand-in binary) |
| `[TC-GEN-160]` | An engine that stops answering is stopped and started again | ✅ (stand-in binary) |
| `[TC-GEN-161]` | The same settings change nothing; a new memory model restarts only the engine, with the new config | ✅ (stand-in binary) |
| `[TC-GEN-162]` | A binary whose checksum does not match, or no binary, turns memory off and the hub still answers | ✅ (stand-in binary) |
| `[TC-GEN-163]` | ai-memory 3.4.2 serves `<data folder>/memory` from the hub's config, and writes no bearer into any config file there | ✅ |
| `[TC-GEN-164]` | The root bearer works from `AI_MEMORY_AUTH_TOKEN` only, as `user:you`; an `X-Memory-Actor-User` header on it is ignored; a wrong or missing bearer gets 401 | ✅ |
| `[TC-GEN-165]` | The proxy bearer works from `AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN` only, as the asserted `hob-<id>`; without an asserted actor it gets 400 | ✅ |
| `[TC-GEN-166]` | Over `/mcp`, `memory_write_page` as a hob records the hob as the page's author (`last_modified_by`), and `memory_query` finds it | ✅ |
| `[TC-GEN-167]` | `/hook/batch` stores two events, and the same batch again is acknowledged as `replayed` with no new observation | ✅ |
| `[TC-GEN-168]` | `/api/v1` lists, reads, gives the history of and searches pages | ✅ |
| `[TC-GEN-169]` | `/admin/write-page` as you is attributed to you whatever actor header it carries, `/admin/delete-page` removes a page, a hob gets 403 on `/admin`, and `/admin/backup` holds the config but neither bearer | ✅ |
| `[TC-OP-050]`, `[TC-OP-053]` | Diagnostics' Right now and its report show the engine's state; a hub whose engine failed its checksum says so | ✅ server test; browser test not run here |
| `[TC-PE-455]` | A sandboxed command cannot read another process's environment (`ps eww`, `ps -E`, `/proc/<pid>/environ`) | ⚠️ Not run: sandbox-runtime's seccomp helper is missing in this container, so no sandboxed command runs (`TC-PE-114` fails the same way). By hand, bubblewrap with sandbox-runtime's `--unshare-pid --proc /proc` showed only the sandbox's own processes, and the environment of a process outside could not be read. On macOS sandbox-runtime's profile allows `process-info*` only within the same sandbox and no `kern.procargs2` read; to be run there |
| Smoke test | The packaged app starts the engine, starts it again after `kill -9`, and stops it on Quit | ⚠️ Not run: needs a Mac (`pnpm package:mac`, then `apps/desktop/scripts/smoke-test.sh`) |

## Findings

- 3.4.2 shipped the day after 3.4.0, which ADR 028 was written against, with fixes only; Hobbots pins 3.4.2.
- A proxy-asserted hob, and you through `root_username`, are recorded as each version's author in the page's frontmatter (`last_modified_by.username`). The `author` field of `/api/v1` history and the audit log name only ai-memory's own database users, so both are empty for every write Hobbots makes.
- With no `embedding_provider`, ai-memory downloads an 87 MB embedding model at first start. Hobbots sets `embedding_provider = "none"`: search is full text, entities and links, and nothing is downloaded.
- The proxy bearer without `X-Memory-Actor-User` is refused (400), never treated as root.

## Gaps

- The packaged app on macOS, with the engine signed inside it, and `[TC-PE-455]` on macOS: run them on a Mac before this is proven.

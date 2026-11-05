# Memory works on the packaged Mac app with a real Claude Code hob

- **Date:** 2026-11-05
- **Issue:** [#953](https://github.com/otaviobarros/hobbots/issues/953)
- **Pull request:** [#PRNUM](https://github.com/otaviobarros/hobbots/pull/PRNUM)
- **Commit:** the pull request's head, on `main` at `5f18030`
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64, an ad hoc signed `pnpm package:mac` build, Node 24.15.0, ai-memory 3.4.2, Claude Code 2.1.316 on a signed-in subscription with the `haiku` model. Every run used a new data folder (`--user-data-dir`), never the Mac's Hobbots data, and turned opening at login off.
- **Result:** Passed with gaps. The app starts, restarts and stops the engine, a mismatched checksum turns memory off and not the app, and a real hob's save reaches the Memory page, an export and its next thread. The next thread's brief failed at first: `main` never gave chat turns the memory store, which this pull request fixes.

## Checks

| Case | Check | Result |
|---|---|---|
| Smoke test | `apps/desktop/scripts/smoke-test.sh`, six runs, the first on a freshly built app: the engine starts, starts again after `kill -9`, and stops with the app | ✅ Six of six, so the quit that failed once in [the first record](2026-11-05-memory-engine.md) did not come back |
| Binary | The bundled binary's SHA-256 matches `ai-memory.sha256`, its ad hoc signature verifies, and it reports 3.4.2 | ✅ |
| Checksum | A copy of the app with one byte added to the binary: the hub answers, `/api/diagnostics` says off with reason `checksum`, and no engine process runs | ✅ |
| Keys | The engine's environment (`ps eww`) is the three bearers, `HOME`, `PATH` and `NO_COLOR` only. `memory-keys` is owner-only. None of the three values is in any other file of the data folder, the runtimes folder, the app's logs or an export | ✅ |
| Diagnostics | Settings › Help and about › Technical details in the app's own window, after `kill -9`: Memory 3.4.2, Running, "Memory stopped now and Hobbots started it again." | ✅ |
| Quit | A quit Apple Event to the running app stops the app, the server and the engine | ✅ |
| Save | A real turn calls `memory_save`, and the save shows as `saved` in its thread and as a page in Moss's memory on the Memory page | ✅ |
| Brief, before the fix | A new thread's prompt holds no brief, and the hob says it does not know | ❌ on `main`; fixed here |
| `[TC-UX-978]` | Through the whole server on the fake runtime, a page a hob saved reaches its next thread's brief. It fails without the fix | ✅ |
| Brief, after the fix | On the rebuilt app, a new thread's prompt holds "From your memory", and the hob answers from it with no tool call | ✅ |
| Export | Export everything holds `memory/hobs/Moss/deploy-habit.md`. The same fix reaches exports, which read the store the same way | ✅ |
| Sandbox | A real hob's Bash tool, on the engine's pid: `ps eww`, `ps -E` and `ps -o command=` are refused, `cat memory-keys` and `ls ~/.claude` are refused, and `env` holds no memory or token variable | ✅ |
| `[TC-PE-455]` | The sandbox case, on this Mac | ✅ |
| `[TC-GEN-183]`–`[TC-GEN-189]` | `HOBBOTS_MEMORY_CONTRACT=1 pnpm --filter @hobbots/memory test`, on this Mac: 136 of 136 | ✅ |

## Findings

- Earlier records proved the brief and exports on hubs built for the test, which provide the memory store directly. The server's own layers kept the store inside the memory tools, so `Effect.serviceOption(MemoryStore)` found none and both carried on as a hub without memory, silently.
- A hob declined to save a page with a "codeword" in it, as a secret. It saved the same fact once the text said it was a harmless nickname.

## Gaps

- The x64 app was built but not run, and a Developer ID signed and notarized build does not exist yet.
- Quit used an Apple Event, not a click on the menu.

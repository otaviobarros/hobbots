# Memory search finds plain questions, word starts and short words on real Claude Code and Codex hobs

- **Date:** 2026-11-06
- **Issue:** [#1047](https://github.com/otaviobarros/hobbots/issues/1047)
- **Pull request:** [#1052](https://github.com/otaviobarros/hobbots/pull/1052)
- **Commit:** `47ea06b` on `claude/project-thread-l6klan`, in a separate worktree with a clean tree
- **Setup:** an arm64 Mac, the hub from source (`pnpm --filter @hobbots/server start`) with the built web app, ai-memory 3.4.2 fetched with `fetch-engine`, and a new data folder, never the Mac's Hobbots data. Hobs: Moss on Claude Code with the `haiku` model, and Fern on Codex with `gpt-5.6-luna`, the smallest model the hub offers there, both on low effort, each on a signed-in subscription. Memory held `facts/tests.md` ("# How this project runs its tests", body "This project runs its tests with `make tide-check`."), `facts/team.md` ("# Team", body "IT owns the laptops.") and filler pages, all in everyone's memory.
- **Result:** Passed. Every query found the page it should on both runtimes and through the Memory page's search API, and the query no page answers found nothing.

## Checks

Paths are the ones in each `memory_search` tool result, read from the runtime's transcript, not the hob's summary of it.

| Query | Claude Code | Codex | `GET /api/memory/search` |
|---|---|---|---|
| `how does this project run its tests` | ✅ `facts/tests.md` | ✅ `facts/tests.md` | ✅ `facts/tests.md` first |
| `run tests` | ✅ `facts/tests.md` | ✅ `facts/tests.md` | ✅ `facts/tests.md` |
| `tes` | ✅ `facts/tests.md` | ✅ `facts/tests.md` | ✅ `facts/tests.md` |
| `tide` | ✅ `facts/tests.md` | ✅ `facts/tests.md` | ✅ `facts/tests.md` |
| `tide-check` | ✅ `facts/tests.md` | ✅ `facts/tests.md` | ✅ `facts/tests.md` |
| `IT onboarding` | ✅ `facts/team.md` | ✅ `facts/team.md` | ✅ `facts/team.md` |
| `lint rules` | ✅ nothing | ✅ nothing | ✅ nothing |

- **A hob searches on its own.** With 26 newer filler pages in everyone's memory, so that `facts/tests.md` was no longer in the hob's brief, a new thread asked "How does this project run its tests? Check your memory." Moss searched `run tests test command project` and Fern `project run tests test command`. Each got 8 hits with `facts/tests.md` first and answered `make tide-check`.
- **Ranking.** With 28 pages in memory, the plain question answered `facts/tests.md` first, then the filler pages that hold "project".
- The hub's log held no error or warning line.

## Gaps

- The Memory page was checked through its API, not in the browser. `[TC-UX-1047-01]` covers the page in the browser on the fake memory.
- Every page was in everyone's memory, so a hob's own memory and a project's memory were not searched on real turns. The shared store contract covers every scope.
- The run used the hub from source, not a packaged build.

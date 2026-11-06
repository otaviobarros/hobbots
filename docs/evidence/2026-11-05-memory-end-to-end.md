# Memory holds end to end on the hub and the bundled ai-memory

- **Date:** 2026-11-05
- **Issue:** [#964](https://github.com/otaviobarros/hobbots/issues/964)
- **Pull request:** [#1001](https://github.com/otaviobarros/hobbots/pull/1001)
- **Commit:** the pull request's head, stacked on [#998](https://github.com/otaviobarros/hobbots/pull/998) over `main` at `5f18030`. CI's [run 42128777858](https://github.com/otaviobarros/hobbots/actions/runs/42128777858) tested head `6b1f4b6`.
- **Setup:** GitHub Actions `ubuntu-latest` (x64), Node from `.node-version`, SQLite, the bundled ai-memory 3.4.2 with no model, fetched by `fetch-engine` and checked against its SHA-256. The hub runs as `main.ts` composes it, in its own process, on the fake runtime, which makes the hobs' scripted tool calls. Also run in a Linux x64 container on Node 22.
- **Result:** Passed with gaps. All of #964's scenarios pass on the fake runtime against the real engine. A real Claude Code or Codex thread and the browser were not part of this run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-CH-289]` | A lesson a hob saves with `memory_save` is in its next thread's brief and `memory_search`. Another hob in the same project gets neither | ✅ |
| `[TC-GEN-387]` | A project share waits in the Inbox, and another hob finds nothing until you share it. It is then briefed from the page, which is written as the first hob | ✅ |
| `[TC-GEN-388]` | The engine is killed mid-reply and its binary taken away. The reply ends, a save is kept, and a new thread is told memory is unavailable. After a restart the save arrives once, and the archived thread's one session page holds every turn | ✅ |
| `[TC-GEN-389]` | A chat lists only its own saves. Undo puts back what a save replaced or removes the page it made, and is refused once you change the page. The hob's page counts what it reads | ✅ in CI and in 8 more local runs. ❌ once in one local full-suite run under load: Undo answered 409 where 200 was expected, with the reason not captured. The check now prints the refusal |
| `[TC-OP-107]` | An export holds the hob's page. A backup restored through Settings brings back the page, its history and the next thread's brief, with new memory keys | ✅ |
| Without the fixes | On `main`, the first four fail: the hub never gave turns or exports the memory store (fixed in #998). With #998 alone, the fake runtime's hobs still wrote to memory kept in the hub's process (fixed here) | ❌ before, ✅ after |
| Suites | `HOBBOTS_MEMORY_CONTRACT=1` memory tests 136 of 136, and server tests 591 of 591 in CI | ✅ |

## Findings

- With the fake runtime and an engine to run, the memory tools and shares used an in-process memory. Briefs, the Memory page, captures and backups read ai-memory. The fake runtime now keeps memory in-process only when there is no engine.

## Gaps

- A real Claude Code or Codex thread captured into memory, a real hob's share, and Codex calling the memory tools: manual steps on a Mac, [#964](https://github.com/otaviobarros/hobbots/issues/964).
- The browser against the real engine. The browser jobs run without it.
- The one unexplained `[TC-GEN-389]` refusal.

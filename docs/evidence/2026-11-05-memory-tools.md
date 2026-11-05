# Hobs search and save their memory through the hub's memory tools

- **Date:** 2026-11-05
- **Issue:** [#955](https://github.com/otaviobarros/hobbots/issues/955)
- **Pull request:** [#975](https://github.com/otaviobarros/hobbots/pull/975)
- **Commit:** not yet on `main` (ran on the pull request branch at `8c64fd4`, which builds on `main` at `5e0d5ed`)
- **Setup:** Linux x86_64, Node 22.23.4. The tool cases ran on the in-memory store and on the bundled ai-memory 3.4.2 (linux-x64, fetched with `pnpm --filter @hobbots/memory fetch-engine`) started as the hub starts it, with the hub's policy engine and save records in memory. The save record ran on SQLite and on PostgreSQL 16. The end-to-end case ran a hub from source on the fake runtime and SQLite, with memory in the hub's process.
- **Result:** Passed with gaps. A hob saves a page to its own memory and finds it from its next thread, on the in-memory store and on ai-memory. A retried key returns the first answer and writes once. Another hob finds nothing of it. A Never answer refuses the call before memory sees it. A save made while memory is down is kept. A secret in a save's page, tags or key reaches neither the save record nor its journal events. No real Claude Code or Codex turn was run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-240]`–`[TC-GEN-242]` | The save record: recorded and journaled once per key, settled only from sending or queued, and listed as unsent until saved. On SQLite and PostgreSQL. | ✅ |
| `[TC-GEN-243]` | Both tools are offered under every preset, and a page saved to the hob's own memory is found by its next search. | ✅ |
| `[TC-GEN-244]` | A save is recorded and journaled before it is sent, as the hob that made it. A secret in its page, tags and key is in neither the record nor its two journal events, and the same call again still writes once. | ✅ |
| `[TC-GEN-245]` | A retried key answers its first answer and writes once; the key used for another save is refused; the next piece of work may use it again. | ✅ |
| `[TC-GEN-246]`–`[TC-GEN-251]` | Memory down, each scope, a share refused without its service, a Never and an Ask answer, and a hob reaching for another hob's memory. | ✅ |
| `[TC-GEN-252]` | Claude Code and Codex advertise `memory_search` and `memory_save` with no adapter change. | ✅ |
| `[TC-GEN-253]` | Two clones of one repository share a memory project. | ✅ |
| `[TC-GEN-254]` | On the fake runtime, end to end: a save in one thread is found in the next, a retry in the same turn adds no second version, another hob finds nothing, and a `save-memory` override of Never refuses before memory sees the call. | ✅ |
| `[TC-GEN-255]` | On the bundled ai-memory: a save to the hob's own memory, found from its next thread, written once for a retried key, and not found by another hob. | ✅ |

The domain, agents, permissions, orchestration, memory, persistence, runtimes, charms and web suites pass, as does the server suite except `[TC-DP-008]`, which needs IPv6 that this container lacks.

## Gaps

- No Claude Code or Codex turn called the tools. The hub gives a real runtime's hobs the tools over the ai-memory store while memory is on, and both runtimes serve them as any hub tools, but a signed-in turn was not run.
- A save kept while memory is down is sent by the capture worker: [#956](https://github.com/otaviobarros/hobbots/issues/956).
- A share to a project or to everyone is refused until the hub takes shares: [#960](https://github.com/otaviobarros/hobbots/issues/960).

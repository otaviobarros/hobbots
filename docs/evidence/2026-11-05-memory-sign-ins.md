# The memory model runs on your connected sign-ins

- **Date:** 2026-11-05
- **Issue:** [#980](https://github.com/otaviobarros/hobbots/issues/980)
- **Pull request:** this change's pull request
- **Commit:** the pull request's head; not yet on `main`
- **Setup:** Linux x86_64 container (Node 22.23.4) with ai-memory 3.4.2 for `linux-x64`, fetched by `pnpm --filter @hobbots/memory fetch-engine`, and stand-in runtime adapters in place of Claude Code and Codex. Run with `pnpm --filter @hobbots/memory test`, `pnpm --filter @hobbots/runtimes test`, `pnpm --filter @hobbots/server test`, `pnpm --filter @hobbots/web test` and the browser test `memory-settings.e2e.ts`.
- **Result:** Passed with gaps. ai-memory reaches a model only through the hub's memory model endpoint, which runs each request as one turn of no hob's on the runtime's own adapter, with no API key; a real Claude Code or Codex sign-in was not used.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-212]` | The default writes the endpoint as the only provider, the runtime's smallest model at low effort, and the model bearer's variable, never a key | ✅ |
| `[TC-GEN-213]` | No AI writes no model setting at all | ✅ |
| `[TC-GEN-214]` | The fallback is the other runtime's smallest model on the same endpoint; plain summaries write none | ✅ |
| `[TC-GEN-215]` | A task given its own model gets its own table on the endpoint; summaries with no AI turn off `consolidate_on_session_end` | ✅ |
| `[TC-GEN-217]`, `[TC-GEN-218]` | ai-memory 3.4.2 starts with the endpoint's config, and with no model under No AI | ✅ |
| `[TC-GEN-317]` | ai-memory 3.4.2's model test reaches the chosen runtime as one turn, with no API key in its environment | ✅ |
| `[TC-GEN-318]` | A limited Codex plan falls back to Claude's smallest model; with a signed-out runtime and plain summaries the model test fails, so summaries are written with no AI | ✅ |
| `[TC-GEN-319]` | A finished chat's summary is written by the chosen runtime's model, as a turn that keeps no session | ✅ |
| `[TC-GEN-313]` | The endpoint runs one turn on each runtime's own adapter with no tools, hub tools, approvals, folders or session, and answers as OpenAI does | ✅ |
| `[TC-GEN-314]` | A model the runtime stopped offering runs on its smallest, at an effort the model takes | ✅ |
| `[TC-GEN-315]` | A plan's limit answers `429` with `Retry-After` and is shown until a task runs again | ✅ |
| `[TC-GEN-316]` | A signed-out runtime answers `503` with no detail; a wrong bearer, runtime or request never reaches a runtime | ✅ |
| `[TC-GEN-219]` to `[TC-GEN-221]`, `[TC-GEN-320]` | The hub answers what memory runs with: the model, a replaced model, a signed-out runtime and a limit | ✅ |
| `[TC-RT-505]`, `[TC-RT-506]` | A memory turn keeps no session on Claude Code (`--no-session-persistence`) or Codex (an ephemeral thread) | ✅ |
| `[TC-GEN-222]`, `[TC-GEN-224]` | In a browser: Settings offers the runtime's own models and efforts, and a refused effort is kept with Try again | ✅ |

## Findings

- ai-memory 3.4.2's `openai-compat` provider takes a base URL and a key variable per table, so the hub can be its only provider, and it treats `429` and `5xx` as transient, so its fallback chain applies to a limited or signed-out runtime.
- With `llm_compat_strict = false`, ai-memory puts the summary's schema in the prompt, which any runtime's model can follow.

## Gaps

- No turn ran on a real Claude Code or Codex sign-in here; the end-to-end run on the packaged app is [#964](https://github.com/otaviobarros/hobbots/issues/964).
- Not run on macOS or in the packaged app.

# Which web search Codex offers the model for each setting, with a stand-in model

- **Date:** 2026-11-08
- **Issue:** [#1265](https://github.com/otaviobarros/hobbots/issues/1265)
- **Pull request:** the pull request that adds [ADR 036](../decisions/036-web-search-and-pages.md)
- **Commit:** `ad8f03c` on `main`, for the probe; no Hobbots code ran
- **Setup:** Manual probe in a Linux x86_64 container (Node 22). Codex 0.166.0 and 0.167.0 (`@openai/codex` from npm), each with a throwaway `CODEX_HOME` and no account. A stand-in for the Responses API, set as a custom model provider (`wire_api = "responses"`), as in the ADR 024 probe, answered every request with a short reply and recorded the `tools` it was sent. Two ways of starting Codex: `codex app-server` over stdio driven by a small JSON-RPC client with Hobbots' settings (`thread/start` with `approvalPolicy: "untrusted"` and `sandbox: "danger-full-access"`, `turn/start` with `sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" }`, as `packages/runtimes/src/codex/turn.ts` sends them), and `codex exec` with `--sandbox read-only` or `--sandbox danger-full-access`. The setting under test was `web_search` in `config.toml` or as `-c`. App Server types came from `codex app-server generate-ts`. No macOS, no Hobbots sandbox, no real model, so no real search ran.
- **Result:** Passed with gaps. With Hobbots' App Server settings, `"cached"` offers search without live access on both versions, but the same setting under `codex exec` with a full-access sandbox offers live access, and only a system-wide requirement holds it. What a real search reports was not observed.

## Checks

The `web_search` tool in the first model request. `external_web_access: true` is live access: OpenAI's servers may open pages.

| Case | Check | Result |
|---|---|---|
| Probe | App Server, Hobbots' settings, `"disabled"` (0.167.0) | No `web_search` tool |
| Probe | App Server, Hobbots' settings, `"cached"` (0.166.0 and 0.167.0) | ✅ `web_search` with `external_web_access: false` |
| Probe | App Server, Hobbots' settings, `"live"` (0.166.0 and 0.167.0) | `external_web_access: true` |
| Probe | App Server, Hobbots' settings, `"indexed"` (0.167.0) | `external_web_access: true`, `indexed_web_access: true` |
| Probe | `codex exec --sandbox read-only`, `"cached"` or no setting (0.167.0) | `external_web_access: false` |
| Probe | `codex exec --sandbox danger-full-access`, `"cached"` or no setting (0.166.0 and 0.167.0) | ❌ `external_web_access: true`: cached becomes live |
| Probe | `codex exec --sandbox danger-full-access`, `"live"`, with `allowed_web_search_modes = ["disabled", "cached"]` in `CODEX_HOME/requirements.toml` (0.167.0) | ❌ Ignored: `external_web_access: true` |
| Probe | The same requirement in `/etc/codex/requirements.toml`, with `"live"` or `"cached"` under `danger-full-access`, and `"live"` under `read-only` (0.167.0) | ✅ `external_web_access: false` each time, with the warning "Configured value for `web_search_mode` is disallowed by requirements; falling back to required value Cached" |
| Types | `WebSearchMode` (0.167.0) | `"disabled" \| "cached" \| "indexed" \| "live"` |
| Types | `webSearch` thread item (0.167.0) | `id`, `query`, `action` (`search` with `query`/`queries`, `openPage` with `url`, `findInPage` with `url` and `pattern`, or `other`), and `results`, documented as "returned out-of-band by standalone web search", nullable |
| Types | `[tools.web_search]` (0.167.0) | `context_size`, `allowed_domains`, `location` |
| Types | `ThreadTokenUsage` (0.167.0) | Token counts only; no search count |

## Gaps

- A resumed thread's requests were not checked. The clean-runtime contract test checks both: [#1266](https://github.com/otaviobarros/hobbots/issues/1266).
- Whether a real cached search fills `results`, and what its `webSearch` items report with a signed-in Codex: [#1266](https://github.com/otaviobarros/hobbots/issues/1266).
- Claude Code's `WebSearch` result and `web_search_requests` were read from the Agent SDK 0.3.311 types, not observed in a real search: [#1266](https://github.com/otaviobarros/hobbots/issues/1266).
- macOS, and Codex inside Hobbots' sandbox: [#1272](https://github.com/otaviobarros/hobbots/issues/1272).

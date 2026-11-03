# A hob's turn runs on Codex: answers, stops and resumes, with a stand-in model

- **Date:** 2026-11-03
- **Issue:** [#438](https://github.com/otaviobarros/hobbots/issues/438)
- **Pull request:** [#562](https://github.com/otaviobarros/hobbots/pull/562)
- **Commit:** `6057992` on the pull request's branch, not yet on `main`
- **Setup:** Linux x86_64 container (Ubuntu 24.04, Node 22). Codex 0.166.0 (`@openai/codex` from npm, the native `codex` binary of `@openai/codex-linux-x64`), started by the adapter's turn runner as `codex app-server` with a hob's own `CODEX_HOME`. No account: a scripted stand-in for the Responses API, set as a custom model provider, played the model and recorded each request. No macOS, no Hobbots sandbox around Codex, no real model or ChatGPT sign-in. Run with `HOBBOTS_CODEX=<codex> pnpm --filter @hobbots/runtimes exec vitest run test/codex-live.test.ts`.
- **Result:** Passed with gaps. On an installed Codex, a turn answered, was stopped mid-turn once Codex acknowledged the interrupt, resumed its thread in a new process with changed instructions, and a turn whose Codex was killed ended as uncertain; a real model, a real sign-in and macOS are not verified.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-RT-029]` | A first turn answers: the text streams, the reply completes with that text, Codex's thread ID as the session and this turn's tokens (input without cached input, cached input as cache reads) | ✅ |
| `[TC-RT-029]` | The first model request carries the hob's instructions and the no-attribution rule, and offers no `view_image`, web search or sub-agent tool | ✅ |
| `[TC-RT-029]` | A second turn resumes the thread in a new App Server: the model request carries the earlier turn and the changed instructions, inside the turn | ✅ |
| `[TC-RT-030]` | Cancelling while the model is mid-response sends `turn/interrupt`, and the turn ends once `turn/completed` reports `interrupted`, well inside the grace period; the thread then takes another turn | ✅ |
| `[TC-RT-031]` | Codex killed while the model is mid-response: the turn fails as uncertain ("may or may not have finished"), never as done | ✅ |
| `[TC-RT-020]` to `[TC-RT-028]` | With a scripted App Server in CI: streaming and usage, thread and turn settings (`untrusted`, external sandbox, no attribution), resume with a briefing, interrupt and its acknowledgement, a lost process with calls left uncertain, every tool call refused and reported as denied, failures and the usage limit, sign-in and refresh through the protocol only, and the hob's Codex settings | ✅ |

## Gaps

- A real model and a real ChatGPT sign-in (`chatgptAuthTokens` and its refresh), on macOS in the Mac app: [#442](https://github.com/otaviobarros/hobbots/issues/442), with the sign-in itself in [#437](https://github.com/otaviobarros/hobbots/issues/437).
- Tool calls under the policy, and Codex inside Hobbots' sandbox; until then every call is refused: [#439](https://github.com/otaviobarros/hobbots/issues/439).
- Hub tools: [#440](https://github.com/otaviobarros/hobbots/issues/440).
- Two turns of one hob at once on one `CODEX_HOME`, and the contents of `account/rateLimits/updated`: not checked here.

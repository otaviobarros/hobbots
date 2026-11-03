# A hob on Codex delegates and reports through hub tools

- **Date:** 2026-11-03
- **Issue:** [#440](https://github.com/otaviobarros/hobbots/issues/440)
- **Pull request:** PR_PLACEHOLDER
- **Commit:** COMMIT_PLACEHOLDER on the pull request's branch, not yet on `main`
- **Setup:** Linux x86_64 container (Ubuntu 24.04, Node 22). Codex 0.166.0 (`@openai/codex` from npm) started by the adapter's turn runner as `codex app-server` with a hob's own `CODEX_HOME`, and a scripted stand-in for the Responses API as a custom model provider, which played the model's tool calls and recorded each request. Run with `HOBBOTS_CODEX=<codex> pnpm --filter @hobbots/runtimes exec vitest run test/codex-live.test.ts`. The hub-level cases ran in CI's suite with the real Codex adapter against a stand-in `codex` executable that speaks the App Server protocol, and the fake runtime as Claude Code, on SQLite. No macOS, no Hobbots sandbox around Codex, no real model or ChatGPT sign-in.
- **Result:** Passed with gaps. A Codex hob delegated to a Claude hob and got its result, a Claude hob delegated to a Codex hob and got its result, and each hub tool call was decided by the hub as a step; a real model on macOS is not verified.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-RT-080]` | A new Codex thread declares the turn's hub tools as dynamic tools; a call reaches the hub with its step, shows as a step from the moment Codex asks, waits on an approval the hub asks for on that step, and ends with Codex's record of the call; no MCP server, hub address or token reaches Codex's process | ✅ |
| `[TC-RT-081]` | The hub, not the tool's name, decides each call: a tool the turn does not hold is refused, and a resumed thread on a turn with no hub tools refuses every call | ✅ |
| `[TC-RT-082]` | A Codex that exits after the hub answered but before it recorded the answer leaves the call uncertain, and the turn fails as uncertain | ✅ |
| `[TC-RT-083]` | On an installed Codex 0.166.0: a declared hub tool is offered to the model, its call reaches the hub with a step, and the hub's answer reaches the next model request; a resumed thread keeps the tools it started with and ignores new ones | ✅ |
| `[TC-RT-084]` | At hub level: a Claude hob delegates to a Codex hob, whose turn completes its Task through `complete_task`, and the result reaches the Claude hob | ✅ |
| `[TC-RT-085]` | At hub level: a Codex hob delegates to a Claude hob through `delegate_task`, the call shows as a step of its reply, and the result reaches the Codex hob in a later turn of the same Codex thread | ✅ |

## Gaps

- A real model and a real ChatGPT sign-in, on macOS in the Mac app: [#442](https://github.com/otaviobarros/hobbots/issues/442).
- Commands and file changes under the policy, and Codex inside Hobbots' sandbox: [#439](https://github.com/otaviobarros/hobbots/issues/439).
- The hub-level cases on PostgreSQL: they ran on SQLite here, and CI's PostgreSQL job runs the same suite.
- A Charm granted after a Codex thread started is not offered in that thread, because Codex keeps the tools a thread started with (ADR 024).

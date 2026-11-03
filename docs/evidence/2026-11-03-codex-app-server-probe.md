# Codex App Server behaves as ADR 024 relies on, with a stand-in model

- **Date:** 2026-11-03
- **Issue:** [#436](https://github.com/otaviobarros/hobbots/issues/436)
- **Pull request:** [#460](https://github.com/otaviobarros/hobbots/pull/460)
- **Commit:** `05e0658` on `main`, for the probe; no Hobbots code ran
- **Setup:** Manual probe in a Linux x86_64 container (Ubuntu 24.04, Node 22). Codex 0.166.0 (`@openai/codex` from npm, `codex-cli 0.166.0`), started as `codex app-server` over stdio with a throwaway `CODEX_HOME` and no account. A small JSON-RPC client drove it. A scripted stand-in for the Responses API, set as a custom model provider (`wire_api = "responses"`, no OpenAI sign-in), returned fixed tool calls through Codex's code mode (`exec`) and recorded each request. The protocol types came from `codex app-server generate-ts --experimental`. No macOS, no Hobbots sandbox, no real model.
- **Result:** Passed with gaps. Every App Server behavior ADR 024 relies on was observed, except those that need macOS, the sandbox or a real sign-in.

## Checks

| Case | Check | Result |
|---|---|---|
| Probe | `initialize` with `experimentalApi`, then `account/read` and `getAuthStatus` (`includeToken: false`) while signed out | ✅ `account: null`, `authToken: null`, `requiresOpenaiAuth: true` |
| Probe | `model/list` while signed out | ✅ Models with supported efforts (`low` to `ultra`), default effort and input types |
| Probe | Under `approvalPolicy: "untrusted"` with `danger-full-access`, then with an `externalSandbox` turn: which commands ask | ✅ Every one asked: `cat`, `touch`, `ls`, `git status`, `rg`, `pwd`, a pipeline, `echo` |
| Probe | The same commands under `on-request` and `never` | ✅ None asked |
| Probe | A patch (`apply_patch`) | ✅ Asked through `item/fileChange/requestApproval` |
| Probe | A tool of a configured stdio MCP server | ✅ Asked through `mcpServer/elicitation/request` (`codex_approval_kind: "mcp_tool_call"`), then ran |
| Probe | A dynamic tool declared on `thread/start` | ✅ Offered to the model; its call reached the client as `item/tool/call` and the answer reached the model |
| Probe | A command answered `decline` | ✅ Did not run; item status `declined`; the model saw "rejected by user" |
| Probe | `view_image` on a file outside the thread's folder | ❌ Ran without asking (ADR 024 turns it off) |
| Probe | `turn/interrupt` during `sleep 20; touch late` | ✅ `{}` at once, `turn/completed` with status `interrupted` about 0.3 s later; `late` never appeared |
| Probe | `turn/interrupt` while a command approval waited, then a late `accept` | ✅ Approval resolved (`serverRequest/resolved`); nothing ran |
| Probe | `thread/resume` in a new process | ✅ Three earlier turns restored and sent to the model |
| Probe | `thread/resume` with new `developerInstructions` | ✅ Ignored: the next request carried only the first instructions |
| Probe | `thread/tokenUsage/updated` | ✅ Last and total input, cached input, output and reasoning tokens, and the context window |
| Probe | A command's environment | ✅ `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` passed through; so did a variable named `MY_TOKEN` |
| Probe | A `PreToolUse` hook in `CODEX_HOME/config.toml`, trusted there | ✅ Saw shell commands as `Bash`, `apply_patch` and the dynamic tool; refused a command with its reason |
| Probe | The same hook given with `-c` on the command line | ✅ Listed as untrusted and never ran; its trust cannot be given that way |
| Probe | A folder's `.codex/config.toml` with a hook and an MCP server | ✅ Hook listed as untrusted; MCP server not started; the folder's `AGENTS.md` read as instructions |
| Probe | Codex attribution in the first model request, in a Git repository | ✅ No `<git_attribution>` block with the stand-in provider; `commit_attribution` reported as an unrecognized setting |

## Gaps

- macOS, and Codex inside Hobbots' sandbox on any system: [#439](https://github.com/otaviobarros/hobbots/issues/439).
- A real ChatGPT sign-in: `account/read` signed in, `getAuthStatus` with a token, `chatgptAuthTokens` and its refresh: [#437](https://github.com/otaviobarros/hobbots/issues/437).
- Whether Codex asks a signed-in model for the attribution trailer, and whether it can be turned off: [#439](https://github.com/otaviobarros/hobbots/issues/439).
- A real model's turns, the contents of `account/rateLimits/updated`, and two turns of one hob at once on one `CODEX_HOME`: [#438](https://github.com/otaviobarros/hobbots/issues/438).

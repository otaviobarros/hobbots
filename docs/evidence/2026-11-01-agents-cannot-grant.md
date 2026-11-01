# Only the user decides approvals, and a hob's commands never reach the hub

- **Date:** 2026-11-01
- **Issue:** [#216](https://github.com/otaviobarros/hobbots/issues/216)
- **Pull request:** [#266](https://github.com/otaviobarros/hobbots/pull/266)
- **Commit:** not yet on `main` (ran on the pull request branch at `5a118cb`, whose production code is the same as the reviewed `2cedb86`)
- **Setup:** Automated hub cases with the fake runtime on Linux x86_64, Node 22.23.4, SQLite in memory; CI runs them on SQLite and PostgreSQL. The sandbox case and the manual run on a MacBook Pro with macOS 27.0.1 (26A434), the real Seatbelt sandbox (sandbox-runtime 0.0.81) and Claude Code 2.1.316 signed in with a claude.ai login, against a hub from source on a temporary data folder, port 4399, preset Trusting.
- **Result:** Passed with gaps. Requests that are not from a user session are refused and logged and change nothing, and a real Claude Code hob's `curl` with a forged `Origin` never reached the hub; the user-session check is not authentication, so an unsandboxed hob is not covered.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-110]` | Hub level: a script (no `Origin`) and another web page cannot approve, deny or list a pending Push request or list grants; each attempt gets `403 UserSessionRequired` and a log line. The user approving Always from the app saves a grant, which neither can revoke. | ✅ |
| `[TC-PE-113]` | Hub level: neither can widen a hob's folders or signing, or the setup's preset and folders, so a refused decision cannot be sidestepped. | ✅ |
| `[TC-PE-112]` | Every route of the approvals, grants, permissions and setup groups carries the user-session middleware, and no code but the middleware and the services that require it names `UserSession`. | ✅ |
| `[TC-PE-111]` | Hub level: another hob's tool calls aimed at the hub (made-up Hobbots MCP tools, `WebFetch` to the hub) are refused and recorded as denied steps, and the request stays pending. | ✅ |
| `[TC-PE-114]` | macOS, real sandbox: a sandboxed command with a forged `Origin` and every host allowed tries the hub's decision, revoke and setup routes on `127.0.0.1`, `localhost`, `[::1]` and `127.1`, through the proxy, around it with `--noproxy` and unset proxy variables, and over a raw socket. Nothing reached the stand-in hub, which the same request reaches from outside the sandbox. | ✅ |
| `[TC-PE-016]` | macOS, real sandbox: the existing folder and credential checks, as a sanity check of the sandbox on this Mac. | ✅ |
| Manual | Real Claude Code under Trusting ran three commands in one turn: `curl` with the hub's own `Origin` to change the setup, to approve a request on `localhost`, and with `--noproxy '*'` to turn on commit signing. Each failed with `curl: (7) Failed to connect … Couldn't connect to server`, with no approval card, and the reply records each as a failed step, the only record, since the hub never got the request. The hub answered the user's own requests throughout; its log has none of the hob's requests and no refusal, so they ended inside the sandbox. The setup and the hob's permissions were byte for byte the same before and after, and no grant exists. | ✅ |

## Gaps

- The user-session check trusts the browser's `Origin` and `Sec-Fetch-Site` headers until device tokens exist. A hob running without the sandbox could send them, so for it the rule is checked, not enforced (deployment contract).
- `/api/events` is not behind the check, so approval and grant events still reach any local reader of the stream.
- On Linux the sandbox case did not run: the sandbox-runtime package installed here ships no seccomp helper for Linux, so sandboxed commands do not start. CI on Ubuntu skips it.

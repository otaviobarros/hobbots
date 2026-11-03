# A sandboxed Codex turn reaches ChatGPT on macOS

- **Date:** 2026-11-03
- **Issue:** [#648](https://github.com/otaviobarros/hobbots/issues/648)
- **Pull request:** [#651](https://github.com/otaviobarros/hobbots/pull/651)
- **Commit:** the code of `5f7bcf2` on the pull request's branch, run from the working tree just before it was committed (the commit only reformatted the test file); not yet on `main`
- **Setup:** macOS 27.0.1 on Apple silicon, Node 24.15.0, Codex 0.166.0 from Homebrew (`/opt/homebrew/bin/codex`), sandbox-runtime 0.0.81, signed in to Codex with a real ChatGPT account, model `gpt-6-luna`. A throwaway Vitest file, not committed, called `runCodexTurn` with the real `ProcessSandbox` and `PolicyEngine`, a hob on Balanced with one folder and approvals that allow, and the prompt "Reply with the single word: pong". The hub's own sign-in step ran outside the sandbox, as in the app.
- **Result:** Passed with gaps. Before the fix, the same turn with tools failed with "workspace routing discovery failed", and the same turn without tools, which runs outside the sandbox, completed. With the fix and no CA variable set by hand, the turn with tools completed inside the sandbox and replied "pong".

## Checks

| Case | Check | Result |
|---|---|---|
| By hand | Before the fix: a turn with tools, inside the sandbox, with a real ChatGPT sign-in, fails with "workspace routing discovery failed". The proxy allowed `chatgpt.com:443` each time, so the request failed after the proxy | ✅ Reproduced |
| By hand | Before the fix, with `SSL_CERT_FILE=/etc/ssl/cert.pem` added to the sandboxed command by hand: the turn completes, so the failure is TLS verification, not the network | ✅ |
| By hand | With the fix, nothing added by hand: the hub gives Codex `CODEX_CA_CERTIFICATE=/etc/ssl/cert.pem`, and the turn completes inside the sandbox and replies "pong" | ✅ |
| `[TC-RT-106]` | In the real sandbox, the command that starts Codex (`/bin/sh` in its place) gets `CODEX_CA_CERTIFICATE` through the wrap and can read the bundle it names. This proves the variable and the file reach Codex, not that Codex verifies TLS with them; the run above covers that | ✅ |

## Findings

- On macOS Codex loads its trusted roots through `com.apple.trustd.agent`. sandbox-runtime opens that service only with `enableWeakerNetworkIsolation`, which its docs describe as a data exfiltration path, so it stays closed.
- With TLS working, Codex also asked the proxy for `api.github.com`, `codeload.github.com` and `files.openai.com` to sync its curated plugins. The run allowed them; in the app the hob's policy decides them like any other host.

## Gaps

- The fix in the Mac app itself, with Frodo's thread: not run yet, it needs the pull request merged and the app restarted.
- A user's own CA bundle under the home folder was covered by `[TC-RT-106]` only with a stand-in file, not with a real proxy's certificate.

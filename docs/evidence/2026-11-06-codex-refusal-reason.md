# A Codex hob reads why its call was refused

- **Date:** 2026-11-06
- **Issue:** [#1082](https://github.com/otaviobarros/hobbots/issues/1082)
- **Pull request:** the pull request that closes #1082
- **Commit:** `38056f1` on the pull request's branch, not yet on `main`
- **Setup:** Linux x86_64 container, Node 22. Codex 0.166.0 from npm (`@openai/codex@0.166.0` and its Linux platform package), started by the adapter's turn runner as `codex app-server` with a hob's own `CODEX_HOME` and the hob's policy, without Hobbots' sandbox. No account: a scripted stand-in for the Responses API played the model. The App Server's request and response types were read from `codex app-server generate-ts` on the same build. Run with `HOBBOTS_CODEX=<codex> pnpm --filter @hobbots/runtimes exec vitest run test/codex-live.test.ts`.
- **Result:** Passed with gaps. Codex 0.166.0's `decline` takes no text, but `turn/steer` sent before the decline put the reason into the model's next request, right after Codex's own "rejected by user" answer. A real model and the packaged Mac app are not verified.

## Checks

| Case | Check | Result |
|---|---|---|
| By hand | In Codex 0.166.0's generated protocol, `CommandExecutionApprovalDecision` and `FileChangeApprovalDecision` carry no message; `turn/steer` takes text input for the running turn, checked against `expectedTurnId` | ✅ |
| `[TC-RT-1082-04]` | The stand-in runs `git -c user.name=Frodo -c user.email=frodo@example.com commit -m notes`; the policy refuses it without asking the user. The next model request holds, in order, the `function_call`, its `function_call_output` "exec_command failed: CreateProcess { message: \"Rejected(\\\"rejected by user\\\")\" }", and a user message `<call-refused>` naming the command, saying the user was not asked, and giving the policy's reason ("Run Git without setting who commits: …"). The turn completes with the stand-in's reply | ✅ |
| `[TC-RT-069]` | An allowed command and file change still run and are recorded | ✅ |
| `[TC-RT-1082-01]`, `[TC-RT-1082-02]` | With the policy engine in CI: a command the policy refuses and one the hub refuses before deciding (typing into a running command) are told with their reason and "the user was not asked"; one the user denies is told as refused by the user with the user's reason; an allowed one is told nothing | ✅ |
| `[TC-RT-1082-03]` | With a scripted App Server in CI: on a turn without tools, a command and a file change are each told with `turn/steer` on the running turn, and declined | ✅ |
| `[TC-OR-639]` | The commit contract every runtime runs: Codex's case now checks what the hob is told, which names who the hub says commits | ✅ |

## Gaps

- A real model (`gpt-6-luna`) in the packaged Mac app inside Hobbots' sandbox, repeating #1082's party Quest: the hob should fix its command on the first retry: [#1082](https://github.com/otaviobarros/hobbots/issues/1082).
- Codex still tells the model "rejected by user" next to the note; the note corrects it, but Codex 0.166.0 offers no way to change that text.

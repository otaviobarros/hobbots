# Codex's tool calls are decided by the hob's policy, and Codex starts inside the sandbox

- **Date:** 2026-11-03
- **Issue:** [#439](https://github.com/otaviobarros/hobbots/issues/439)
- **Pull request:** the pull request that closes #439
- **Commit:** `717b0de` on the pull request's branch, not yet on `main`
- **Setup:** Linux x86_64 container (Ubuntu 24.04, Node 22, gVisor), with bubblewrap 0.9 and socat installed for sandbox-runtime 0.0.81. Codex 0.166.0 from npm (`@openai/codex` and `@openai/codex-linux-x64`). No account: a scripted stand-in for the Responses API played the model and called Codex's own tools (`exec_command`, `apply_patch`). No macOS, no real model or ChatGPT sign-in. Run with `HOBBOTS_CODEX=<codex> pnpm --filter @hobbots/runtimes exec vitest run test/codex-live.test.ts`; the sandboxed case also needs `HOBBOTS_SANDBOX_TESTS=1` on Linux and a checkout outside the home folder.
- **Result:** Passed with gaps. On an installed Codex, a command the policy asks about waited for the user, ran after Allow, was recorded before it ran and reported its output and end, and a file change was decided and recorded on its path. Codex started inside bubblewrap with its home closed but for what it writes. A whole turn inside the sandbox did not run here, because the sandbox's network proxy refuses every connection in this container, Claude Code's included; it needs the check on macOS.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-RT-069]` | On an installed Codex, decided as if sandboxed: the stand-in model runs a command, Codex asks the hub, the policy answers Ask, the user allows it, the hub records `ToolStarted` (with the command line, live output on) and only then answers `accept`; the command's output and exit code end its step; a patch that adds a file is allowed and recorded as `apply_patch` on that file, and the file is written | ✅ |
| `[TC-RT-061]` to `[TC-RT-066]` | With the policy engine in CI: an allowed command recorded before it runs and its streamed output followed; a call that could not be recorded declined; Ask held until the user allows, declined with the user's reason when denied, and declined with nobody to ask; outside the folders and without the sandbox declined; typing into a running command declined; a file change decided on every path it touches, a move out of the folders refused, its diff shown to the user, and a change whose files Codex never named declined; the script inside `<shell> -lc` decided rather than the wrapper | ✅ |
| `[TC-RT-067]` | With a scripted App Server: a turn with tools starts Codex in the hob's first folder, inside the sandbox, after one start outside it to set up its home; the sandbox gets the folders, the model hosts and only the writable parts of the home; the folder and its repository are written untrusted; Codex's shell is offered only when the policy would let a command run; the instructions carry the sandbox note; no Claude Code variable or sign-in reaches Codex, outside the sandbox or inside it, even when the wrap hands them back | ✅ |
| `[TC-RT-070]` | With the policy engine in CI: a file change that deletes a file is decided as a deletion, alone or with edits, so Balanced asks first, it is declined with nobody to ask, and a hob that may never delete has it refused; an edit alone still runs | ✅ |
| `[TC-RT-060]` | The adapter declares tool interception and tool events verified, the process sandbox unsupported where it did not start and verified only on macOS, so the profile keeps commands closed elsewhere | ✅ |
| By hand | Codex 0.166.0 started inside bubblewrap with the turn's rules, through the npm script and its platform package, and reached its model request. It needed write access, beyond ADR 024's list, to `tmp/` (its helper programs on Linux) and to `installation_id`, which it opens for writing at every start; everything else in its home stayed read-only | ✅ |
| `[TC-RT-068]` | Inside the sandbox: a command writes an allow rule into the home's `rules/` and the folder's `.codex/rules`, changes `config.toml` and reads `~/.ssh`; only the folder's rule is written, and in the next turn the command it names still asks | ⚠️ Not run here: the sandbox's proxy answered nothing for any host in this container (`TC-PE-114` fails the same way for Claude Code), so Codex never reached the stand-in model |

## Findings

- Codex reports each command as its shell wrapper, `/bin/bash -lc '<script>'`, the argument list joined and quoted. The policy decides the script inside it.
- `item/started` for a file change carries its files (absolute paths, kind, diff) and arrives before `item/fileChange/requestApproval`, whose own parameters name no file. The gate waits for that item.
- Codex 0.166.0 offers `exec_command`, `write_stdin`, `request_user_input`, `apply_patch` and its goal tools. `write_stdin` asks with `kind: "writeStdin"`, which the hub declines. `features.shell_tool = false` removes `exec_command`.
- On Linux, sandbox-runtime mounts a folder opened for reading after the writable folders inside it, which hides them. The sandbox scope now lists what the runtime may read in its folder one by one.
- On Linux, sandbox-runtime's seccomp helper sits in the hub's own `node_modules`; a hub installed under the home folder cannot run it, since the home folder is closed. That applies to Claude Code too and stays with the Linux verification.

## Gaps

- A whole Codex turn inside the sandbox, on macOS in the Mac app, and the rule-writing check above: by hand before #439 closes, and with a real model in [#442](https://github.com/otaviobarros/hobbots/issues/442).
- A real sign-in and Codex's own attribution trailer once signed in: [#442](https://github.com/otaviobarros/hobbots/issues/442).

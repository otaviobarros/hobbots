# Commit signing with 1Password inside the macOS sandbox

- **Date:** 2026-10-31
- **Issue:** [#234](https://github.com/otaviobarros/hobbots/issues/234)
- **Pull request:** [#239](https://github.com/otaviobarros/hobbots/pull/239)
- **Commit:** `main` at `cce12af` (before this pull request), for the probe
- **Setup:** Manual, on the maintainer's Mac: 1Password with its SSH agent on, and a global Git config that signs with `gpg.format = ssh`, `gpg.ssh.program = /Applications/1Password.app/Contents/MacOS/op-ssh-sign` and `commit.gpgsign = true`. A probe script ran sandbox-runtime 0.0.81 (`srt`, from `packages/runtimes`) with no network, writes allowed only to a throwaway repository under `/tmp`, and `network.allowUnixSockets` either empty or set to 1Password's agent socket. Each run made `git commit --allow-empty -S` and counted `gpgsig` in the commit.
- **Result:** Passed. The socket is all `op-ssh-sign` needs inside the sandbox, a hob with the switch on signs, and one with it off does not.

## Checks

| Case | Check | Result |
|---|---|---|
| Probe | 1Password's agent socket exists at `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock` | ✅ |
| Probe | Sandboxed, socket closed | ✅ Fails: `fatal: failed to write commit object` |
| Probe | Sandboxed, socket open | ✅ Signed (`gpgsig` present) |
| Probe | Outside the sandbox (control) | ✅ Signed |
| `[TC-PE-085]` | On macOS: a turn with the agent reaches a stand-in socket and keeps signing on; a turn wrapped after it without the agent cannot reach it and has signing off | ✅ |
| Hob turn | Frodo on real Claude Code, with "Sign commits with my 1Password key" on, commits in a test branch on this pull request's head (2026-11-01) | ✅ Signed (`gpgsig` present) |
| Hob turn | The same, with the switch turned off | ✅ Unsigned (no `gpgsig`); `commit.gpgsign` reads `false` from the hub's command environment |

## Gaps

- `git log --format=%G?` shows `N` for an SSH-signed commit when `gpg.ssh.allowedSignersFile` is not set, so the checks count `gpgsig` in the commit instead.
- Linux was not probed: sandbox-runtime does not open a Unix socket by path there, so signing stays off.

# Start over works on the packaged Mac app and a macOS keychain

- **Date:** 2026-11-05
- **Issue:** [#950](https://github.com/otaviobarros/hobbots/issues/950)
- **Pull request:** [#998](https://github.com/otaviobarros/hobbots/pull/998)
- **Commit:** the pull request's head, on `main` at `5f18030`
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64, an ad hoc signed `pnpm package:mac` build on the fake runtime, Node 24.15.0. The app ran with its own `HOME` and data folder, so `security` used a throwaway keychain in that `HOME`. The owner's login keychain and data folder were checked before and after, and did not change.
- **Result:** Passed with gaps. Start over works from the app's own window, a keychain that refuses a delete stops it, and the `reset` command works. A locked keychain does not stop it: macOS deletes the items, so the check the issue asked for holds for a refusal and not for a lock.

## Checks

| Case | Check | Result |
|---|---|---|
| Window | Settings › Your data › Start over in the app's own window: the hub stops and starts again in place with a new installation ID, the window shows All clear with a new key, and Start fresh opens Welcome | ✅ |
| Keychain items | After Start over, `security find-generic-password -s <service>` finds no `ai.hobbots.github` and no `ai.hobbots.github.hob-app` item | ✅ |
| Keychain locked | Keychain locked, confirmed with `SecKeychainGetStatus` before and after: Start over deletes both items, with no password prompt, and finishes | ⚠️ It does not refuse. See Findings |
| Keychain refuses | Keychain file made immutable with `chflags uchg`: `security` exits 161, the window says "Nothing was deleted", names the hob's app key and the GitHub sign-in, and the installation ID, the hob and the items stay | ✅ |
| `reset --yes` | Hub stopped, a hob with a `hob_github_apps` row and a key in the keychain, and the sign-in item: both items are gone, and the data folder holds only the desktop app's own settings | ✅ |
| `reset`, no `--yes` | Says what it deletes, and deletes nothing | ✅ |
| `reset`, hub running | With the port chosen in `network.json`: it exits 1, and the database and the items stay | ✅ |
| `reset`, hub running on another port | With `HOBBOTS_PORT` set only on the app: it does not find the hub and deletes the data | ❌ [#999](https://github.com/otaviobarros/hobbots/issues/999) |
| Second device | A browser allowed over the tailnet address, shown with its Tailscale node under Devices: after Start over its device is gone, its cookie gets 401, and remote access is off, so the tailnet address no longer answers | ✅ |

## Findings

- `security delete-generic-password` deletes items from a locked keychain with no prompt and exit code 0. Reading or adding to a locked keychain does ask for its password. Two items were deleted this way in a direct test, one written with `add-generic-password` and one with `security -i` as Hobbots writes them, and the keychain stayed locked. So nothing is left behind, and the "kept" path needs a keychain that refuses. Its message still says to unlock the keychain.
- `reset` looks for a running hub on one port, so a hub on a port only its own process knows is missed. See [#999](https://github.com/otaviobarros/hobbots/issues/999).

## Gaps

- The keychain was a throwaway one, not the login keychain. Its items were written for the test, not by a GitHub sign-in, because the item name is fixed and a run on the login keychain would delete the owner's real sign-in.
- The hob's GitHub App was a database row with no app on GitHub. `reset` does not call GitHub. The window's path for removing a real app's installations was not run.
- The tailnet browser ran on the hub's own Mac, through the hub's tailnet address, not on a second computer.
- The refusal text of `reset` was not captured, only its exit code and that nothing was deleted.

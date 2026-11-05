# Start over deletes everything the hub keeps and brings it back empty at Welcome

- **Date:** 2026-11-05
- **Issue:** [#948](https://github.com/otaviobarros/hobbots/issues/948)
- **Pull request:** [#949](https://github.com/otaviobarros/hobbots/pull/949)
- **Commit:** not yet on `main` (ran on the pull request branch at `bb37f46`, and again at `3677cf1` for the keychain checks, which builds on `main` at `b4dcb48`)
- **Setup:** Linux x86_64, Node 26.13.0, the fake runtime, SQLite, no Secret Service (`secret-tool` not installed). Browser case in Chromium against a hub from source serving the web build. Hub cases on real SQLite files in temporary data folders, with in-memory keychains and stand-ins for the GitHub services.
- **Result:** Passed with gaps. From Settings › Your data, a backup made in the dialog lands in the folder chosen under Backups, the hub deletes its data and comes back as a new installation, the old browser device no longer gets in, and the browser pairs again through the pairing screen before Welcome. A keychain that refuses a delete, or never answers one for an item the hub recorded, stops the reset with nothing deleted. The packaged Mac app and the macOS Keychain were not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OP-098]` | A hub with a hob. Under Backups the person types another folder. Find a setting finds Start over by "reset". Keep my data closes the dialog. The dialog names the chosen folder, Back up first saves there and shows the backup's path. With the check box ticked, Delete everything ends at All clear, the hub has a new installation ID and no `reset.json`, and the browser's old device cookie gets 401. All clear says the browser must be allowed again; its button opens the pairing screen, Ask for access shows a code, the hub's window (a context with the window key) sees the request with that code in the Inbox and allows it, and the browser opens Welcome. | ✅ |
| `[TC-OP-094]` | Every hub entry of the data folder, the runtimes folder and a folder a restore set aside are deleted; the desktop app's own files and a sibling folder stay. | ✅ |
| `[TC-OP-095]` | A data folder without the marker is left as it is. With the marker and half the data deleted, the next start finishes the reset. | ✅ |
| `[TC-OP-096]` | Start over erases each hob's GitHub app, retired ones too, then the GitHub sign-in, then asks the hub to restart. | ✅ |
| `[TC-OP-099]` | When the keychain keeps a hob's key, Start over fails with which item it kept and never asks the hub to restart. | ✅ |
| `[TC-OP-101]` | A hob's app is made, then its key delete times out: erasing it says the hub could not tell whether the key was deleted, the app stays recorded as left over so asking again says the same, a hob that never had an app counts as clear, and once the keychain answers the key is gone. Through the hub's own hob app service. | ✅ |
| `[TC-OP-102]` | With GitHub connected and the sign-in delete timing out, erasing it says so and keeps the account; once the keychain answers, the item and the account are gone. Through the hub's own GitHub account service. | ✅ |
| `[TC-OP-103]` | With no account connected and a keychain that cannot be reached, the GitHub sign-in counts as gone. | ✅ |
| `[TC-OP-104]` | The `reset` command's keychain step reports a timed-out delete for a hob with an app and for a connected account, and none when the hub has no record of either. | ✅ |
| `[TC-OP-105]` | Connected, then Disconnect while the keychain refuses the delete: the account stays recorded and the item is still there, so a later erase the keychain never answers says the hub could not tell. Through the hub's own GitHub account service. | ✅ |
| `[TC-OP-106]` | A hob's key write and the cleanup delete both time out: the app is kept as left over, and erasing it says the hub could not tell whether the key was deleted. | ✅ |
| `[TC-OP-097]` | A hub that cannot restart itself refuses and changes nothing. | ✅ |
| `[TC-OP-100]` | The `reset` command's keychain step deletes every hob's key and the GitHub sign-in, and reports a locked keychain's refusal. | ✅ |
| Manual | `pnpm --filter @hobbots/server reset` on a scratch data folder says what goes and changes nothing; with `--yes` it deletes the hub's files and keeps `desktop-settings.json`. | ✅ |

The browser pairing, backup and Start over browser tests pass together. The persistence, server, charms, agents, web and UI suites pass on SQLite, except `[TC-DP-008]`, which needs IPv6 that this container lacks.

## Gaps

- The packaged Mac app, its window renewing its key after the reset, and the macOS Keychain, locked and unlocked, were not run: [#950](https://github.com/otaviobarros/hobbots/issues/950).
- The browser was allowed from a context holding the window key, standing in for the hub's window. The desktop app itself was not run.
- A second device on a tailnet was not run; the old browser's refusal stands in for it.
- A hob's GitHub app stays on GitHub with any installations the hub could not remove. Against real GitHub this is not verified: [#420](https://github.com/otaviobarros/hobbots/issues/420).

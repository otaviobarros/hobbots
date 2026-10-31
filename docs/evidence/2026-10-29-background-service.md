# The background service keeps running after the window closes

- **Date:** 2026-10-29
- **Issue:** [#49](https://github.com/otaviobarros/hobbots/issues/49)
- **Pull request:** [#72](https://github.com/otaviobarros/hobbots/pull/72)
- **Commit:** `aeb8ad3` on `main` (ran on the pull request head `5c8f85b`)
- **Setup:** `pnpm package:mac`, then `apps/desktop/scripts/background-service.e2e.ts` against `release/mac-arm64/Hobbots.app` (ad-hoc signed) on Apple silicon with macOS 27.0, the fake runtime, a new empty data folder and `HOBBOTS_PORT=4349`.
- **Result:** Passed with gaps. The four automated checks passed. The log-out and log-in steps were not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-EX-008]` | Close the window while a reply of about 8 seconds streams. The app keeps running, the same server answers and the reply completes with the full text. | ✅ |
| `[TC-DP-010]` | Launch the app a second time. It exits at once with code 0, the running instance opens its window again, and there is still one app process and one server process. | ✅ |
| `[TC-EX-009]` | Read the login-item state from the preload bridge. It is on by default. | ✅ `login item status: enabled` |
| `[TC-EX-010]` | Quit with SIGTERM. The server stops and no app or server process is left. | ✅ |
| `[TC-EX-008]` negative | Seed `keepRunningInMenuBar: false`. Closing the window now asks first, so the test fails, which shows it detects the behavior. | ✅ fails as expected |
| Manual | First start registers the login item. `sfltool dumpbtm` shows `ai.hobbots.app` as `[enabled, allowed, notified]`. | ✅ |

## Gaps

- Log out and back in: Hobbots starts with no window and no Dock icon, the menu-bar icon shows Running, and `/api/health` answers. Not run.
- Open Hobbots from the menu-bar icon after logging in. Not run.
- Turn off "Open Hobbots at login", log out and in, and Hobbots does not start. Not run.
- The release workflow runs these checks on both architectures, but no version tag has run it yet. Pull-request CI does not package the app.

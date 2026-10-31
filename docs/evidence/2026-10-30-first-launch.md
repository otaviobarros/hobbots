# A new installation goes from Welcome to Home

- **Date:** 2026-10-30
- **Issue:** [#70](https://github.com/otaviobarros/hobbots/issues/70)
- **Pull request:** [#92](https://github.com/otaviobarros/hobbots/pull/92)
- **Commit:** `386eabc` on `main` (ran on the pull request head `8c68dd4`)
- **Setup:** Playwright in `apps/web/e2e` with Chromium, each test on a hub from source with its own empty data folder. Run locally on macOS and in the `First launch in a browser` CI job on Ubuntu. Real Claude Code 2.1.301 checked through the hub from source, health only.
- **Result:** Passed with gaps. The automated flow passes locally and in CI. The run on the packaged app with a real Claude Code login was not recorded.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OP-015]` | With the fake runtime: Welcome, Where Hobbots runs, connect Claude, first hob, Safety, Folders, Summon, Home. After a hub restart, a new browser context opens on Home, and `#/welcome` redirects to Home. | ✅ |
| `[TC-AG-009]` | A missing Claude Code shows Not found, the install guide and Check again. Continue stays unavailable. | ✅ |
| `[TC-AG-010]` | A signed-out Claude Code shows Signed out with the sign-in fix. Setup stays blocked. | ✅ |
| Manual | Real Claude Code 2.1.301 reports `ready` through the hub from source. No prompt was sent. | ✅ |

## Gaps

- The packaged Mac app on Apple silicon with a real Claude Code login: Welcome, setup, summon, Home, one message, quit, reopen on Home. Not recorded.

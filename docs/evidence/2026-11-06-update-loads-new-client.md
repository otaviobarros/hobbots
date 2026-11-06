# The first window after an update from 0.0.1 runs the new web client

- **Date:** 2026-11-06
- **Issue:** [#1079](https://github.com/otaviobarros/hobbots/issues/1079)
- **Pull request:** [#1080](https://github.com/otaviobarros/hobbots/pull/1080)
- **Commit:** `3b1a635` on `claude/project-thread-l8c44n`
- **Setup:** an arm64 Mac. The old build was the v0.0.1 release `.dmg` for arm64. The new build came from `pnpm package:mac` at `3b1a635`, as an ad-hoc signed arm64 `.dmg` (sha256 `9cc65cbd34c11512174fd63ce2fe3b28bf7274e69a1410507eb45e8e40e95d63`) whose version is still 0.0.2. Each app was run by path on the same new `--user-data-dir`, and its window was driven over the Chrome DevTools Protocol. Setup was not completed, so the window stayed on Welcome.
- **Result:** Passed with gaps. With a cache that 0.0.1 had filled and was reusing without asking the hub, the first launch of the new build loaded the new client with no reload, and Memory worked. Signed install and auto-update paths were not run.

## Checks

| Case | Check | Result |
|---|---|---|
| Manual | 0.0.1, first launch, which fills the cache | ✅ Health 0.0.1. The window loads `main-DmZE-DeY.js`, with a navigation `transferSize` of 7969 and 1759219 for `main.js`. |
| Manual | 0.0.1, second launch: the #1079 state | ✅ Health 0.0.1. The navigation `transferSize` is 0 and every asset is 0, so the window came from the cache. `desktop-settings.json` has no `appVersion`. |
| `[TC-DP-275]` | New build, first launch on the same data folder | ✅ Health 0.0.2. The window loads `main-CQqMm7RO.js`, with a navigation `transferSize` of 7992 and 1947048 for `main.js`, without a reload. The sidebar shows Memory, and `#/memory` renders the Memory page, not Not Found. |
| `[TC-DP-275]` | The version is recorded after the clear | ✅ `desktop-settings.json` holds `{"mode":"hub","windowBackground":"#141228","appVersion":"0.0.2"}`. |
| `[TC-DP-275]` | New build, second launch | ✅ The navigation `transferSize` is 300, a 304 revalidation. `main.js` and every other asset are 0, from the cache, so the cache is not cleared again. |
| `[TC-DP-274]` | Cache-Control from the packaged hub | ✅ `/` is `no-cache`. `/assets/main-CQqMm7RO.js` is `public, max-age=31536000, immutable`. `/assets/example` with `Accept: text/html` returns 200 HTML with `no-cache`. `/assets/missing.js` returns 404 with no Cache-Control. |

## Gaps

- **Ad-hoc build:** the build was ad-hoc signed and run by path. Gatekeeper and replacing the app in `/Applications` were not exercised. The tagged release build runs both.
- **Manual update only:** the update was a different binary on the same data folder, not an auto-update. Hobbots has no auto-update yet.
- **No persistent cookie tested:** the clear covers only the HTTP cache, but this run could not show a persistent cookie surviving it. The window's `hobbots_device` cookie is a session cookie that the app sets on every launch, and the Cookies database held no rows. The single `window` device row was unchanged.

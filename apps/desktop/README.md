# apps/desktop

Validation slice implemented ([ADR 009](../../docs/decisions/009-toolchain-and-validation-slice.md)).

Electron client and local-server launcher. Native lifecycle and narrowly scoped integration, with no independent durable application state.

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Run it with `pnpm dev:desktop` from the repository root.

`pnpm package:mac` from the repository root builds the web client and the app, then packages an unsigned (ad-hoc signed) `Hobbots.app` for Apple silicon and Intel with electron-builder ([`electron-builder.config.mjs`](electron-builder.config.mjs)). It writes one installer per architecture, `release/Hobbots-<version>-arm64.dmg` and `release/Hobbots-<version>-x64.dmg`, plus the unpacked apps in `release/mac-arm64/` and `release/mac/`. The installer window shows the app beside an Applications shortcut; drag one onto the other to install, or over an older copy to update it. The packaged app carries the web client in its resources folder and its server serves it on `http://localhost:4317`, where the window and any browser on the Mac open it (the server listens on loopback only). The window is the one client trusted without asking: on every start the server writes a window key to the data folder, and the app sets it as the window's session cookie and sends it with its own requests. A browser asks once ([ADR 021](../../docs/decisions/021-devices-and-remote-access.md)). It runs the Claude Code installed on the Mac, found through the installers' folders and the `PATH` of your login shell (Workshop shows it as outdated, signed out or missing when it needs updating, a sign-in or installing) and keeps its data in `~/Library/Application Support/Hobbots`, outside the app, so replacing the app keeps every thread. A copy downloaded to another Mac must be approved once in System Settings › Privacy & Security.

The app identifies as `ai.hobbots.app`, with the version from this package's `package.json`, the copyright notice from the electron-builder config and the Apache-2.0 `LICENSE` in its resources folder. Its icon is the chief of the hobs (crown, long beard, royal robe and cape, lantern staff) on a starry night tile, drawn cell by cell for every size by [`scripts/app-icon.ts`](scripts/app-icon.ts); run `pnpm --filter @hobbots/desktop icon` (Node 22.18 or later) after changing the art to regenerate `resources/icon.icns` and `resources/icon.png`.

Only one copy of the app runs: opening it again, from Finder, the Dock or a second launch, shows the existing window. Before using a server already on its port, the app checks the identity that `/api/health` reports (an installation ID kept in the data folder's `installation-id` file, the version and the data folder) and uses it only when it belongs to the same data folder, so `pnpm dev` and the packaged app still share one server. Anything else on the port, another program or a Hobbots server for a different data folder, gets an error dialog instead of a window.

The installed app opens at login by default ([ADR 012](../../docs/decisions/012-macos-hub-service.md)). On its first start it registers itself with `app.setLoginItemSettings`, and when macOS opens it at login it starts the server without a window; the Dock or Finder opens the window. The "Open Hobbots at login" switch in Settings › General turns it off and on, and the choice is kept in `desktop-settings.json` in the data folder. The switch shows what macOS reports rather than assuming success, because macOS can refuse an ad-hoc signed build or wait for approval in System Settings › General › Login Items. A development checkout never registers, so Electron itself is not added as a login item. Launching a build to test it, including with the smoke test below, registers that copy; turn the switch off before deleting it.

Hobbots runs as a menu-bar app that owns its server ([ADR 012](../../docs/decisions/012-macos-hub-service.md)). Closing the window leaves the app, the server and any running turns alive, and the Dock icon shows only while a window is open. The menu-bar icon shows whether the server is starting, running, stopped or in trouble and how many hobs are working (from `/api/activity`), opens the window and quits. Quit stops a server this app launched, gracefully and then by force after 10 seconds, and leaves one started separately (`pnpm dev`) running. The "Keep running in the menu bar when the window closes" switch in Settings › General, kept in the same `desktop-settings.json`, turns this off: closing the window then quits Hobbots, asking first when hobs are working or when the server cannot say.

An app opened from Finder does not inherit shell variables. To try it with the fake runtime, quit Hobbots and stop any server on port 4317 first (the app attaches to a running server), then:

```sh
open --env HOBBOTS_RUNTIME=fake apps/desktop/release/mac-arm64/Hobbots.app
```

On Intel, use `release/mac/Hobbots.app`. Packaging for Intel works on Apple silicon, but running that build there needs Rosetta.

Release Please creates the `v<version>` tags ([Releases](../../docs/contributing/releases.md)). Pushing one runs the [release workflow](../../.github/workflows/release.yml): it packages both installers on an Apple silicon runner with the tag's version, smoke-tests each one on its own architecture with [`scripts/smoke-test.sh`](scripts/smoke-test.sh) (installed from its `.dmg`, launched with the fake runtime until `/api/health` answers, then quit), and only then attaches both `.dmg` files to the draft GitHub Release for that tag, creating it with generated notes if Release Please has not drafted one. A new tag with a pre-release suffix such as `v0.1.0-rc.1` makes a pre-release. To smoke-test a local build without touching your Hobbots data:

```sh
apps/desktop/scripts/smoke-test.sh apps/desktop/release/mac-arm64/Hobbots.app --user-data-dir="$(mktemp -d)"
```

After the smoke test, the release workflow runs [`scripts/background-service.e2e.ts`](scripts/background-service.e2e.ts) on Node's test runner against the same app. It starts the app with the fake runtime in a new, empty data folder, starts a reply, closes the window through the DevTools port while the reply streams and checks that the app, the same server and the reply carry on to completion (`TC-EX-008`); launches the app a second time and checks that it quits at once, the first instance opens its window and there is still one app and one server process (`TC-DP-010`); reads back the login-item status macOS reports (`TC-EX-009`); and quits, checking that the server stops (`TC-EX-010`). Run it against a local build, with no Hobbots server on the port, with:

```sh
HOBBOTS_E2E_APP=apps/desktop/release/mac-arm64/Hobbots.app node --test apps/desktop/scripts/background-service.e2e.ts
```

Like any launch, it points the Mac's Hobbots login item at the copy it tested; turn "Open Hobbots at login" off and on again in your installed copy afterwards to point it back.

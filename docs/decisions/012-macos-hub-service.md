# ADR 012 — The hub service on macOS

Status: **Accepted.** Refines [ADR 010](010-desktop-hub.md) for how the hub's background service runs on macOS.

## Context

[ADR 010](010-desktop-hub.md) makes the server a per-user background service that starts at login, survives a closed window and stops on Quit. Today the server is an Electron `utilityProcess` child of Hobbots.app and stops when the app quits. On macOS the app already keeps running after its last window closes, but with no menu-bar icon, no login item and the Dock icon as the only way back, so the server lives only as long as an app session the user started; on other platforms the app quits with its last window.

Two shapes were considered:

- **A. Hobbots.app is the service.** The app becomes a menu-bar app that keeps running with no window, owns the server process and is the login item.
- **B. A separate launchd agent runs the server** with Electron's bundled Node (`ELECTRON_RUN_AS_NODE`), registered through `SMAppService` from a property list in the app bundle, and the app is only a client.

## Decision

Option A, for the MVP and until there is evidence that B is needed.

- **The app is the service.** Hobbots.app keeps running when its last window closes. The server stays a `utilityProcess` child of the main process, so there is one process tree and one place that starts and stops the server.
- **Closing the window is the user's choice.** A switch, "Keep running in the menu bar when the window closes", sits in Settings › General and is on by default. When it is on, closing the last window leaves the app, the server and running work alive. When it is off, closing the last window quits Hobbots as Quit does; if hobs are working, the app first asks, saying that their work will stop and be recovered as interrupted. The switch changes only what closing the window does: the login item and Quit behave the same either way.
- **Menu-bar icon.** A `Tray` with a template image shows the server's state (Starting, Running, Stopped, Error) and offers Open Hobbots, Pause remote access and Quit Hobbots. The Dock icon shows only while a window is open: the app switches between the `regular` and `accessory` activation policies.
- **Quit stops everything.** Quit in the menu-bar icon, the app menu or ⌘Q asks the server to stop, waits for it to exit (with a timeout, then kills it) and then exits the app. Work in progress is recovered as interrupted on the next start ([execution lifecycle](../architecture/execution-lifecycle.md)). A server the app did not start, such as one from `pnpm dev`, is used but never stopped.
- **Login item.** The app registers itself with `app.setLoginItemSettings({ openAtLogin })`, which uses `SMAppService.mainApp` on macOS 13 and later. It is on by default and switchable in Settings › General ("Open Hobbots at login"). Electron 45 removed `openAsHidden`, so the app decides itself: when `getLoginItemSettings().wasOpenedAtLogin` is true it starts the server and the menu-bar icon without a window. Settings shows the registration `status`, including `requires-approval`, which the user resolves in System Settings › General › Login Items.
- **One instance.** The app takes Electron's single-instance lock; a second launch, or opening the app from Finder or the Dock, shows the existing window. Before using a server already listening on the port, the app checks its identity (installation ID, version and data folder from the health endpoint) and shows an error instead of connecting to anything else.
- **The window loads the served client.** Once the server is up and its identity checked, the packaged app's window loads `http://127.0.0.1:<port>/`, the same web client every browser on the hub gets from the server. Every client then shares one origin and one build, and CORS is needed only for the Vite dev server, which `pnpm dev` still loads. Navigation stays limited to that origin, and the preload bridge stays narrow.

## Rationale

Keeping the app alive after the window closes is the default because hobs are meant to keep working ([EX-005](../product/mvp-requirements.md)), but people expect to choose how a menu-bar app behaves, as they do in other apps that live there. The switch makes that choice explicit and warns before it stops work.

A is the smallest change that satisfies ADR 010 on macOS: no extra bundle content, no separate install, update or uninstall step, and no chance of the app and the service running different versions after an update. Quit has one obvious meaning. The menu-bar app is also the familiar shape for an always-on Mac tool.

B's advantage is that the server survives a crash of the app. That matters less here because the server is already a separate process the main process supervises, and durable recovery ([ADR 007](007-durability-and-storage.md)) covers the restart either way. B also costs more: a launchd property list and a second `SMAppService` registration the user approves, a stop that must go through launchd rather than a child process, update ordering between the agent and the app, and `ELECTRON_RUN_AS_NODE`, which a hardened release may want to turn off with Electron's fuses. Nothing in A prevents moving to B later, because clients already talk to the server only over HTTP.

## Consequences

- The app's main process must stay lightweight and stable, since it now lives as long as the server. Heavy work stays in the server.
- Login items are reliable only for signed and notarized apps. Today's builds are ad-hoc signed, so registration may silently fail; the app reads the status back instead of assuming success, and release evidence must come from a signed build. Real signing and notarization remain a release task.
- A crash of the main process takes the server with it until the next launch or login. If that proves common, revisit B.
- Linux and Windows follow the same shape when they are supported: a tray icon, a window that can close, and a login entry for the app itself (`setLoginItemSettings` with a hidden-start argument on Windows, an XDG autostart entry on Linux, where tray support depends on the desktop). Their exact mechanism is decided then; a systemd user service or a startup task for the server alone would be the Option B shape on those platforms.

What changes for the slice 3 issues:

- **#45** keeps the app running when the window closes (unless the switch is off), adds the menu-bar icon, the activation-policy switch and the "Keep running in the menu bar" setting, and makes Quit stop the server gracefully before exiting.
- **#46** registers the login item, starts hidden when `wasOpenedAtLogin` is true, adds the switch and shows the registration status.
- **#47** adds the single-instance lock, the `second-instance` and `activate` handling and the identity check.
- **#48** serves the web client from the server, and the packaged window loads it from the server as described above.

# Desktop standards

Rules for the Electron app in `apps/desktop`. They follow Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security) and [performance checklist](https://www.electronjs.org/docs/latest/tutorial/performance). The renderer runs the same web client as the browser, so the React, UI and i18n rules apply to it as well.

### STD-DESKTOP-001 Renderers are isolated and sandboxed

Every `BrowserWindow` keeps `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. No window turns off `webSecurity`, turns on `allowRunningInsecureContent`, `experimentalFeatures` or `enableBlinkFeatures`, or uses `<webview>`.

- **Why:** a renderer shows text from models and other people, and isolation keeps a bug in it from reaching the machine.
- **Enforced by:** a unit test of the `webPreferences` that `app-window.ts` creates.
- **Applies to:** `apps/desktop/src/main`.

### STD-DESKTOP-002 The preload exposes a narrow, typed bridge

The preload exposes one object through `contextBridge.exposeInMainWorld`. Each member is a function with typed arguments that calls one IPC channel. It never exposes `ipcRenderer`, `ipcRenderer.send`, Node modules or Electron objects.

- **Why:** each exposed function is an entry point into the main process, so the set stays small and known.
- **Enforced by:** `test/preload-bridge.test.ts`, which lists the members the bridge exposes.
- **Applies to:** `apps/desktop/src/preload`.

### STD-DESKTOP-003 Every IPC handler checks its sender and parses its input

Every `ipcMain.handle` checks that the sender frame's URL is one the app trusts, and parses each argument with an Effect Schema before it uses it. A refused or malformed call returns a typed refusal, never an exception with internal details.

- **Why:** any frame that reaches the IPC can call a handler, and an argument from the renderer is untrusted input.
- **Enforced by:** the shared `trusted-ipc.ts` registration, and the frontend check in `pnpm check`, which fails on an `ipcMain.handle` outside it.
- **Applies to:** `apps/desktop/src/main`.

### STD-DESKTOP-004 Navigation, new windows and external links are limited

Every window refuses navigation to a URL the app does not trust and refuses to open new windows. A link meant for the browser goes to `shell.openExternal` only after its URL parses with an `https:` or `http:` scheme. No other scheme and no text that has not been parsed as a URL reaches `shell.openExternal`.

- **Why:** a link in a reply can point to a `file:` path or a custom scheme that runs a program.
- **Enforced by:** a unit test of the navigation, window-open and external-link handlers.
- **Applies to:** `apps/desktop/src/main`.

### STD-DESKTOP-005 Permission requests are denied unless allowed

Every session sets `setPermissionRequestHandler` and `setPermissionCheckHandler`. They refuse every permission, such as camera, microphone, geolocation or notifications from web content, except an explicit list of the ones a feature needs.

- **Why:** without a handler, Electron grants web content's permission requests by default.
- **Enforced by:** a unit test of the handlers.
- **Applies to:** `apps/desktop/src/main`.

### STD-DESKTOP-006 Pages load over the app protocol with a strict CSP

Local pages load from the app's custom protocol, never from `file://`. Every page sets a Content Security Policy that allows scripts only from `'self'`.

- **Why:** `file://` pages can read any file on the machine, and a strict CSP stops injected scripts.
- **Enforced by:** a unit test of the protocol handler, and a check that `apps/web/index.html` carries the policy.
- **Applies to:** `apps/desktop`, `apps/web/index.html`.

### STD-DESKTOP-007 The packaged app flips Electron's fuses

The package config sets `electronFuses`: `runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` off; `enableEmbeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar` and `enableCookieEncryption` on.

- **Why:** the default fuses let another program run code with the app's identity and permissions, for example through `ELECTRON_RUN_AS_NODE`.
- **Enforced by:** `electron-builder.config.mjs`, and a step after `package:mac` and `package:linux` that reads the fuses with `@electron/fuses read` and fails on a wrong one.
- **Applies to:** `apps/desktop`.

### STD-DESKTOP-008 The main process never blocks

After startup, the main process uses only asynchronous file, process and network calls. Work that takes long runs in a worker or a utility process.

- **Why:** a blocked main process freezes every window and the menu bar.
- **Enforced by:** the frontend check in `pnpm check`, which fails on `*Sync(` calls in `apps/desktop/src/main` outside an opt-out (STD-REACT-020) that explains why the call runs at startup.
- **Applies to:** `apps/desktop/src/main`.

### STD-DESKTOP-009 Electron stays on a supported release

Keep Electron on a supported major release with its latest patch, pinned exactly (STD-DOCS-006). Take a security patch as soon as it ships.

- **Why:** Electron ships Chromium and Node, and their security fixes reach the app only through an Electron update.
- **Enforced by:** dependency update pull requests and review.
- **Applies to:** `apps/desktop`.

### STD-DESKTOP-010 A window never flashes blank or fails silently

A window opens with the active theme's background color, or stays hidden until `ready-to-show`, so it never flashes white. When a renderer crashes, hangs or fails to load (`render-process-gone`, `unresponsive`, `did-fail-load`), the main process logs it and recovers: it reloads the page or shows a message that follows STD-UI-009. The main process also logs uncaught exceptions and unhandled rejections.

- **Why:** a blank or frozen window with no way out is the worst failure a desktop app can show.
- **Enforced by:** a unit test of the window's crash and load-failure handlers.
- **Applies to:** `apps/desktop/src/main`.

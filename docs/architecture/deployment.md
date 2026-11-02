# Deployment and devices

**Decided:** the desktop hub ([ADR 010](../decisions/010-desktop-hub.md)). One computer runs the server as a background service with one SQLite database ([ADR 011](../decisions/011-sqlite-storage.md)). Other devices connect to it as clients over Tailscale, each approved once ([ADR 021](../decisions/021-devices-and-remote-access.md)). Hobs act only on the hub. Single user, one installation.

## Roles

| Role | What it is | What it owns |
|---|---|---|
| Hub | A computer where Hobbots was installed and set to run here. | The server, the database, artifacts, runtime connections and every hob's execution environment. |
| The hub's window | The desktop app's own window on the hub. | Nothing of its own; it is trusted through the window key the hub writes to its data folder on every start. |
| Connected desktop | The desktop app set to connect to another computer. | Only the hub address and its device token, in the OS keychain; no server and no database. |
| Browser | Any browser on the hub, or on the tailnet once remote access is on. | A device token in an `HttpOnly` cookie. |

Every client gets the full experience: chat, Quests, Inbox, approvals and the Workbench. The Workbench shows the hub's files, terminals and browsers; connecting a device never gives hobs access to that device.

## The hub's server

- The desktop app is the background service ([ADR 012](../decisions/012-macos-hub-service.md)). It runs the server as a child process and, by default, keeps running when its last window closes, so the server's life follows the app's, not the window's. Settings › General has a switch, "Keep running in the menu bar when the window closes"; turned off, closing the last window quits Hobbots, after asking if hobs are working.
- On macOS the app is a login item (`SMAppService.mainApp` through Electron's `setLoginItemSettings`), on by default and switchable in Settings › General. Launched at login, it starts the server and the menu-bar icon without opening a window. Settings shows the registration status, including when macOS needs the user's approval.
- The menu-bar icon shows server state (Starting, Running, Stopped, Error) and offers Open, Pause remote access and Quit. The Dock icon shows only while a window is open.
- Quit stops the server gracefully, then exits the app; running work is recovered as interrupted on the next start ([execution lifecycle](execution-lifecycle.md)). A server the app did not start, such as a development server, is used but never stopped.
- Linux and Windows follow the same shape (a tray icon and a login entry for the app) when they are supported; their exact startup mechanism is decided then.
- One app instance and one server per user account. A second launch shows the existing window. The app connects to a running server rather than starting a second one, and first checks the server's identity (installation ID, version and data folder from the health endpoint); anything else on the port is an error, not a server to use.
- The server serves the web client and the API on the same port, 4317 by default, changeable in Settings › Devices. The chosen port and the remote access setting are kept in `network.json` in the data folder, where the desktop app reads the port before it starts or finds the server; `HOBBOTS_PORT` overrides the port, as in development and tests. A changed port moves every listener at once and reaches every client as a `remote-access` event: the desktop app follows it and reloads its windows, and a browser on a page the hub serves moves to the new port. The packaged app's window loads the client from the server like any browser on the hub; only development loads it from the Vite dev server, which forwards the API to the hub so the client still calls it on its own origin.
- Hobs use installed, authenticated runtimes on the hub through supported adapters ([runtime adapters](runtime-adapters.md)). Runtime login stays a vendor flow; credentials never enter conversation history.
- Without remote access the server listens only on loopback. Closing a browser never stops work.

## Execution environments

The hub's execution environments are where hob work runs: the hub itself and any sandbox or container the hub starts. Each advertises its platform, runtime versions, filesystem, terminal, browser and computer capability evidence, capacity and health. Scheduling needs a matching runtime, permitted resources, verified enforcement and free capacity. A lost heartbeat marks observations unverified and triggers reconciliation; it does not prove the process stopped.

## Remote access over Tailscale

Tailscale is the MVP route.

- Remote access is off until the user turns it on in onboarding or in Settings › Devices.
- When it is on and Tailscale is running, the server also listens on the hub's tailnet addresses, read from `tailscale status`, and accepts only loopback and tailnet peers that `tailscale whois` knows. Its address is `http://<magicdns-name>:4317`. Until devices can pair (#338), it answers every tailnet request with `403`.
- Optionally, `tailscale serve` gives the hub an HTTPS address on the tailnet. Hobbots shows the command or runs it with the user's consent; it never changes Tailscale settings silently and never uses Funnel.
- If Tailscale disconnects, the server stops listening on the tailnet and Settings › Devices says why. It never falls back to other interfaces.
- Pause remote access in the menu-bar icon closes the tailnet listener until Resume; loopback keeps working.
- Tailnet membership is not authentication. Every request still needs an approved device token, bound to the Tailscale node it was approved on.

[ADR 021](../decisions/021-devices-and-remote-access.md) decides the listener, the peer and host checks, HTTPS and Pause.

## Device approval

1. A new device opens the hub's address, in a browser or in the desktop app's connect screen.
2. The device shows "Waiting for approval on <hub name>" with a six-digit matching code.
3. The hub shows an Allow / Deny / Decide later prompt with the device's name, platform, Tailscale identity and the same code. The prompt appears in the hub's window, its notification and the Inbox of every client already approved. A request expires after 10 minutes, or 24 hours after Decide later, and rate limits keep a peer from flooding the hub with requests.
4. Allow issues a device token to the waiting device, which alone holds the pairing secret that claims it; Deny ends the attempt, and the device can ask again later.
5. Settings › Devices lists every approved device with its last activity. Revoke removes its token at once: open streams close and the next request is refused.

Every new device asks once, including devices on the same Tailscale account and the hub's own browsers. Only the hub's own desktop window is trusted without asking; no setting trusts local browsers. Device tokens are separate from agent MCP credentials and runtime credentials, are stored only as hashes on the hub, and are never shown again after issue. Every API route and the event stream need a device, and the user session that decides approvals and grants comes from it. [ADR 021](../decisions/021-devices-and-remote-access.md) decides the token format, pairing, origin and CSRF rules, and how development and tests get a device.

## Connection routes

A route decides how a client reaches the hub; device approval and the API are the same on every route. Routes sit behind one interface, so later routes (a relay, local network with HTTPS, public HTTPS, a server install) need no client changes. Each new route must keep explicit opt-in, TLS where traffic leaves the tailnet or loopback, origin validation, rate limits and CSRF protection for cookie sessions.

## Electron boundary

Keep privileged process and runtime operations in the server and the main process. Expose a narrow, validated preload bridge for necessary native functions, with context isolation and renderer restrictions that follow current Electron guidance. Treat tool output and external pages as untrusted content without native privileges. In connect mode the app holds no server privileges; it is a client of the hub like a browser.

## Release evidence

Verify that the window closing leaves (with the default setting) the server and running work alive; Quit leaves no Hobbots process running; the service starts at login without a window, on a signed build, and recovers incomplete work; opening the app twice never starts a second server; another program on the server's port produces an error, not a connection; a connected desktop and a tailnet browser see the same records; an unapproved device is refused; a revoked device is cut off mid-stream; turning off Tailscale removes the tailnet listener; a changed port reaches every client; backups restore data and artifact references. Supported OS and architectures remain open until validated.

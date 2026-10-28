# Deployment and devices

**Decided:** the desktop hub ([ADR 010](../decisions/010-desktop-hub.md)). One computer runs the server as a background service with one SQLite database ([ADR 011](../decisions/011-sqlite-storage.md)). Other devices connect to it as clients over Tailscale, each approved once. Hobs act only on the hub. Single user, one installation.

## Roles

| Role | What it is | What it owns |
|---|---|---|
| Hub | A computer where Hobbots was installed and set to run here. | The server, the database, artifacts, runtime connections and every hob's execution environment. |
| Connected desktop | The desktop app set to connect to another computer. | Only the hub address and its device token; no server and no database. |
| Browser | Any browser on the hub, or on the tailnet once remote access is on. | A device token in the browser session. |

Every client gets the full experience: chat, Quests, Inbox, approvals and the Workbench. The Workbench shows the hub's files, terminals and browsers; connecting a device never gives hobs access to that device.

## The hub's server

- The desktop app installs the server as a per-user background service that starts at login: a login item on macOS, a systemd user service on Linux and a startup task on Windows.
- Closing the window leaves the server running. The tray or menu-bar icon shows server state and offers Open, Pause remote access and Quit. Quit stops the server, and running work is recovered on the next start ([execution lifecycle](execution-lifecycle.md)).
- One server per user account. The app connects to a running server rather than starting a second one and checks the server's identity before it does.
- The server serves the web client and the API on the same port, 4317 by default, changeable in Settings › Devices.
- Hobs use installed, authenticated runtimes on the hub through supported adapters ([runtime adapters](runtime-adapters.md)). Runtime login stays a vendor flow; credentials never enter conversation history.
- Without remote access the server listens only on loopback. Closing a browser never stops work.

## Execution environments

The hub's execution environments are where hob work runs: the hub itself and any sandbox or container the hub starts. Each advertises its platform, runtime versions, filesystem, terminal, browser and computer capability evidence, capacity and health. Scheduling needs a matching runtime, permitted resources, verified enforcement and free capacity. A lost heartbeat marks observations unverified and triggers reconciliation; it does not prove the process stopped.

## Remote access over Tailscale

Tailscale is the MVP route.

- Remote access is off until the user turns it on in onboarding or in Settings › Devices.
- When it is on and Tailscale is connected, the server also listens on the hub's tailnet address and accepts only loopback and tailnet peers. Its address is `http://<magicdns-name>:4317`.
- Optionally, `tailscale serve` gives the hub an HTTPS address on the tailnet. Hobbots shows the command or runs it with the user's consent; it never changes Tailscale settings silently.
- If Tailscale disconnects, the server stops listening on the tailnet and Settings › Devices says why. It never falls back to other interfaces.
- Tailnet membership is not authentication. Every request still needs an approved device token.

## Device approval

1. A new device opens the hub's address, in a browser or in the desktop app's connect screen.
2. The device shows "Waiting for approval on <hub name>" with a short matching code.
3. The hub shows an Allow / Deny prompt with the device's name, platform, Tailscale identity and the same code. The prompt appears in the hub's window, its notification and the Inbox of every client already approved.
4. Allow issues a device token stored on that device; Deny ends the attempt, and the device can ask again later.
5. Settings › Devices lists every approved device with its last activity. Revoke removes its token at once: open streams close and the next request is refused.

Every new device asks once, including devices on the same Tailscale account and the hub's own browsers other than the desktop window. Device tokens are separate from agent MCP credentials and runtime credentials, and are never shown again after issue.

## Connection routes

A route decides how a client reaches the hub; device approval and the API are the same on every route. Routes sit behind one interface, so later routes (a relay, local network with HTTPS, public HTTPS, a server install) need no client changes. Each new route must keep explicit opt-in, TLS where traffic leaves the tailnet or loopback, origin validation, rate limits and CSRF protection for cookie sessions.

## Electron boundary

Keep privileged process and runtime operations in the server and the main process. Expose a narrow, validated preload bridge for necessary native functions, with context isolation and renderer restrictions that follow current Electron guidance. Treat tool output and external pages as untrusted content without native privileges. In connect mode the app holds no server privileges; it is a client of the hub like a browser.

## Release evidence

Verify that the window closing leaves the server and running work alive; the service starts at login and recovers incomplete work; a connected desktop and a tailnet browser see the same records; an unapproved device is refused; a revoked device is cut off mid-stream; turning off Tailscale removes the tailnet listener; a changed port reaches every client; backups restore data and artifact references. Supported OS and architectures remain open until validated.

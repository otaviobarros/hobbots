# ADR 010 — The desktop hub

Status: **Accepted.** Refines [ADR 006](006-server-and-clients.md) for the MVP. [ADR 012](012-macos-hub-service.md) refines how the background service runs on macOS, and [ADR 021](021-devices-and-remote-access.md) decides device approval and the Tailscale route.

## Decision

- **One computer is the hub.** Installing Hobbots on a computer and choosing to run it there makes that computer the hub. It owns the only server, the only database and every runtime connection.
- **The server is a background service.** The desktop app installs it as a per-user service that starts at login (a login item on macOS, a systemd user service on Linux, a startup task on Windows). Closing the window keeps it running; Quit in the tray or menu-bar icon stops it.
- **Other devices are clients.** A second desktop app in "connect" mode, or a browser on the tailnet, uses the hub's API and event stream and keeps no database of its own. Every connected device gets the full experience: chat, Quests, Inbox, approvals and the Workbench.
- **Hobs act only on the hub.** Their files, terminals, browsers and tools are the hub's. Connecting a device never lets hobs reach that device's files or apps.
- **Tailscale is the MVP route.** With remote access on, the server accepts connections only from the hub itself and from the tailnet, at the hub's MagicDNS name on port 4317 by default (changeable). `tailscale serve` can add HTTPS. Without Tailscale connected, remote access is off; the server never falls back to other interfaces.
- **Each new device is approved once.** The hub shows Allow or Deny the first time a device connects, including devices on the same Tailscale account. An allowed device keeps a revocable token and is listed in Settings › Devices.
- **Routes are pluggable.** The connection route sits behind one interface, so other routes (a relay, local network with HTTPS, public HTTPS, a server install) can be added later without changing the clients.
- **The mobile app follows the MVP** and uses the same API.

## Rationale

Installing once, turning on Tailscale and typing the hub's address on another device should be all it takes. Keeping one server and one database avoids synchronization, and keeping execution on the hub keeps authority in one place.

## Consequences

- The hub must be on and reachable for other devices to work.
- Device tokens are separate from agent MCP credentials and runtime credentials, and a revoked device is refused at once.
- The desktop app needs per-platform service installation, single-instance rules and an icon that shows server state.

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- Closing the window keeps the server and a running reply alive, and Quit stops it: `[TC-EX-008]`, `[TC-EX-010]`.
- A second launch starts no second server: `[TC-DP-010]` in `background-service.e2e.ts`.
- Another device on the tailnet connects only after it is allowed once, a browser on the hub asks once too, and only the hub's window is trusted without asking ([ADR 021](021-devices-and-remote-access.md)). Not proven yet: [#338](https://github.com/otaviobarros/hobbots/issues/338), [#339](https://github.com/otaviobarros/hobbots/issues/339).
- With remote access on, the server listens only on loopback and the hub's tailnet addresses, and closes the tailnet listener when Tailscale disconnects. Not proven yet: [#340](https://github.com/otaviobarros/hobbots/issues/340).
- A revoked device is refused at once, its open streams close, and Pause stops tailnet traffic while loopback keeps working. Not proven yet: [#342](https://github.com/otaviobarros/hobbots/issues/342), [#343](https://github.com/otaviobarros/hobbots/issues/343).
- Hobs act only on the hub's files, never the connected device's. Not proven yet: [#15](https://github.com/otaviobarros/hobbots/issues/15).

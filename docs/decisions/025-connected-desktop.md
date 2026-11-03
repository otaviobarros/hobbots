# ADR 025 — The connected desktop

Status: **Accepted.** Finishes the connect mode of [ADR 010](010-desktop-hub.md) (DP-001, DP-002) for the connect mode slice ([#15](https://github.com/otaviobarros/hobbots/issues/15)). Builds on the devices, pairing and Tailscale rules of [ADR 021](021-devices-and-remote-access.md). Changes when the app of [ADR 012](012-macos-hub-service.md) starts its server: only once the computer is a hub.

## Context

ADR 010 says a second desktop app can run in connect mode: a client of the hub with no server and no database of its own. ADR 021 decided how any device pairs, how a connected desktop keeps its token and how it sets the window's cookie. The hub already serves the pairing routes (`packages/api/src/devices.ts`) and reads Tailscale (`apps/server/src/tailscale.ts`). A browser on the tailnet already pairs and works end to end.

What is left is the app itself. Today it always starts a server on launch, and its window loads pages from that server. Setup's first screen, "Where Hobbots runs", is one of those pages, so the server and its database exist before the user has chosen anything. "Connect to Hobbots on another computer" says Coming soon. This ADR decides how the app starts without a server, what its window loads, how it finds a hub and what it can and cannot know about one, what it does when the hub runs another version, and what the user sees when the hub goes away.

## Decision

### Words used here

- **The mode** is what this computer is for Hobbots: a hub, connected to a hub, or not chosen yet.
- **The hub's address** is the origin the connected desktop uses: `http://<MagicDNS name>:<port>`, or `https://<MagicDNS name>` when the user chose the HTTPS address.
- **The hub's node** is the stable ID Tailscale gives the hub's computer, as `tailscale whois` names it.
- **Local pages** are the screens the app ships and shows without any hub: Welcome, Where Hobbots runs, Connect, waiting for approval, and the connection states below.

### The mode and where it is kept

- **In the app's own settings.** The mode joins `desktop-settings.json`, the file in the app's data folder that already holds Open at login and Keep running. It holds `mode: "hub"`, or `mode: "connected"` with the connection, or nothing.
- **The connection** is the hub's address, its name as its health endpoint gave it, the hub's node and this computer's device ID. None of these is a secret. The device token is not in the file (below).
- **An existing hub stays a hub.** A data folder that already holds an installation ID is a hub. The app writes `mode: "hub"` on its first start after this change and never asks.
- **Nothing chosen yet.** With no mode and no installation ID, the app starts no server. It shows the local pages Welcome and Where Hobbots runs.
  - **Run Hobbots on this computer** writes `mode: "hub"`, starts the server as ADR 012 says, and loads the hub's own page at the remote access step of setup.
  - **Connect to Hobbots on another computer** opens Connect (below). The mode becomes `connected` only once the hub allowed this computer and the token is in the keychain.
- **A hub does not become a connected desktop.** The app offers no way to turn a hub into a client in the MVP: its data folder and hobs would be left behind. Moving a hub is post-MVP.
- **Starting in connect mode** runs no server, opens no database, writes no installation ID and reads no `network.json`. The login item works as on a hub, so the menu bar and notifications start at login. The app's data folder holds only `desktop-settings.json` and the browser engine's own storage for its window: the page cache and the local storage of the hub's origin, where unsent messages wait ([ADR 016](016-client-stores-outside-react.md)). That is the same a browser keeps for a site. No hub record is ever written to this computer.

### The device token

- **In the OS keychain**, as ADR 021 says: one item, service `ai.hobbots.device`, through the keychain access of `@hobbots/charms` that keeps the GitHub sign-in. On a computer with no usable keychain, connecting stops with that reason; the token is never written to a file.
- **Pairing as a desktop.** The main process opens the request with `kind: "desktop"` and no `Origin`, keeps the pairing secret in memory and asks every 2 seconds. After Allow, the status that hands over the token also carries the device's ID, so the app can revoke itself on Disconnect. #444 adds `deviceId` to that answer.
- **Sent only to the hub's node.** Before it sends the token or loads a page, the main process asks `tailscale whois` about the address it is about to use and checks that the answer is the hub's node. An address that now belongs to another computer gets no token and no window (connection states, below). The answer is kept for a minute, as the hub keeps its own.
- **Its own requests** send the token as `Authorization: Bearer`: the event stream, the Inbox reads behind notifications and the menu bar's reads.

### What the window loads

- **The hub's own pages.** Once connected, the window loads the hub's address, as a browser on the tailnet would. The pages always match the hub's version, so the user sees exactly what the hub serves, and the app never carries a second copy of the client that could drift from the hub.
- **The cookie.** The main process sets the token as an `HttpOnly`, `SameSite=Strict` session cookie, `Path=/` and no `Domain`, in the window's session, before the first load. It sets two: `hobbots_device` for `http://<MagicDNS name>:<port>`, and `__Host-hobbots_device` with `Secure` for `https://<MagicDNS name>`. So the window keeps its device when the hub moves page loads between its HTTP and HTTPS addresses (ADR 021). The page never reads either cookie. On every start, and after any address change, the main process sets them again from the keychain.
- **Kept out of the cookie store.** The hub refreshes a device cookie on requests that carry one, with its 400-day lifetime (ADR 021). In the window that refresh would write the token to disk. So the main process removes every `Set-Cookie` for `hobbots_device` and `__Host-hobbots_device` from the hub's answers to the window, with Electron's `webRequest.onHeadersReceived`, before the browser engine sees it. Other cookies and the page's local storage are untouched, so unsent messages are still kept. A `401 DeviceRevoked` still reaches the main process, which clears the cookies itself (below). The hub's window is not affected: the hub refreshes only device tokens, not the window key.
- **Where the window may go.** Only those two origins of the hub and the local pages. Any other navigation is refused, and new windows open in the default browser, as today.
- **Before Allow, no hub page loads.** Connect and the waiting screen are local pages. The window shows the hub's pages only once the hub has allowed this computer and the hub's node checks out.
- **Local pages** are a separate entry of the web client, built with the same components and served from the app's resources under a private scheme, `hobbots://app/`, registered with Electron's `protocol.handle` as a standard, secure scheme. They call no API. They talk only to the preload bridge. In development they come from the Vite dev server, like the rest of the client.

### The bridge in connect mode

- **Narrower than on the hub.** The preload bridge answers the hub's pages and the local pages, and nothing else. In connect mode it offers Open at login, Keep running, the notification that opens a request, and `connection`: the hub's name and address, this app's version and the hub's, the connection state, Change address and Disconnect.
- **Nothing that reaches this computer's files.** The folder picker is not offered in connect mode, since a hob's folders are the hub's. The hub's pages fall back to typing a path, as in a browser. No bridge call in either mode runs a program or reads a file the page names.
- **The hub's pages ask the bridge what it offers.** A page reads `window.hobbots` for each call before it uses it, so a hub of another version shows only what this app supports.

### Finding hubs on the tailnet

- **This computer's Tailscale.** Connect needs Tailscale running on this computer too. The app reads it the way the hub does (ADR 021): `tailscale status --json` from the `tailscale` command on the `PATH`, or the Mac app's own binary with `TAILSCALE_BE_CLI=1`. It only reads. It never changes Tailscale's settings. When Tailscale is missing, off or signed out, Connect says which and shows how to get it ready, with the same steps setup shows on a hub.
- **Which peers.** Online peers owned by the same Tailscale user as this computer, from `tailscale status`. A tagged node or another user's node is not asked. Such a node is not the user's own computer, and the hub refuses pairing from other users' devices by default anyway. Connecting to another user's hub is post-MVP.
- **Asking each one.** The app sends `GET /api/health` to `http://<MagicDNS name>:4317`, the default port, with at most eight requests at once and a 2-second timeout each. Each scan sends one request per peer, well inside the hub's limit for requests without a device. A hub on another port is not found; the user types its address.
- **What is listed.** Every peer whose answer is a Hobbots health answer, named by its Tailscale node name, with its MagicDNS name, the name it reports and its version. A hub whose version this app cannot use is listed with that reason, not offered. The list is read when Connect opens and again on Look again.
- **Typing an address.** Connect accepts a MagicDNS name, short or full, with or without a port; an `http://` or `https://` address; or a tailnet address. A short name is completed from `tailscale status`. A missing port means 4317 over HTTP and none over HTTPS. Anything that is not a peer on this tailnet is refused before a request is sent: loopback, local network and public addresses, and names Tailscale does not know. Tailscale is the only route in the MVP (ADR 010).

### What the app can know about a hub, and what the user decides

Nothing a hub sends proves it is a genuine Hobbots hub. A program on a tailnet node can answer like Hobbots in every way: a health answer, a pairing secret, a code, and an approved status that carries a token. The app cannot tell the difference, and this ADR does not claim it can. What the app relies on is narrower.

- **Tailscale names the node.** The address must be a peer that `tailscale whois` knows, owned by the same Tailscale user as this computer. WireGuard proves that traffic to that address comes from that node. Connect and the waiting screen name the computer by what Tailscale says: its node name and owner. The name the hub reports about itself is shown only beside it, never in its place.
- **The user decides which computer to trust.** Picking or typing a hub is the trust step. The waiting screen says so in plain words: "Approve this Mac on <node name>. You should see a prompt with this code there." The six-digit code lets the user check that the prompt they answer on that computer belongs to this Mac (ADR 021).
- **An approval the user did not give is a warning sign, not a proof.** If the app shows that it was allowed before the user answered a prompt on that computer, something else answered. The waiting screen tells the user to cancel in that case. The app cannot detect it, so it does not try.
- **The health answer only filters.** An address must answer `/api/health` with `app: "hobbots"`, a version and a connect protocol this app supports (below), or it is "Not a Hobbots hub" and is never paired with. This keeps the user from pairing with the wrong program by mistake. It stops nothing that wants to pretend.
- **Pinned after Allow.** From then on the app trusts that node, and only that node. Every later connection checks the node first, so an address that later points to another computer gets no token and no page.
- **What a fake hub gets.** A program that pretends to be a hub, on a node the user chose, can show its own pages in the window. It gets what any web page there gets, plus the narrow bridge above: Open at login, Keep running, the hub's name and address, Change address and Disconnect. No bridge call reads a file, runs a program or reaches anything else on this computer. It never learns a real token, since the token it handed over is its own. Running such a program already needs control of a computer on the user's own Tailscale account.

### When versions differ

- **The connect protocol.** The hub's health answer gains `connect`, a whole number, to every caller. It counts changes to what the app's main process relies on: health, pairing, the device's own revoke, the event stream and the reads behind notifications and the menu bar. It goes up only when one of those changes in a way an older app cannot follow. It starts at 1. The app knows the range it supports.
- **Within the range,** the app connects. The pages are the hub's, so the screens match the hub. Settings › Devices on the connected desktop shows both versions. A difference in versions alone stops nothing.
- **A hub below the range** gets "<hub> runs an older Hobbots (<version>). Update Hobbots on <hub> to connect." A hub above it gets "This Mac's Hobbots is too old for <hub>. Update Hobbots on this Mac." The app checks before pairing and on every connection, and never pairs with, or loads pages from, a hub outside the range.
- **The bridge** only grows within a connect protocol: no call is removed or changes meaning. A page uses a call only after checking it exists.

### What the user sees when the hub goes away

The main process follows the hub's event stream. When the stream is lost, it checks, in this order, why the hub cannot be reached. Each check is cheap and reads only this computer's Tailscale and the hub's address.

| Check | What the user sees | What they can do |
|---|---|---|
| Tailscale is not running on this computer | "Tailscale is off on this Mac." | Open Tailscale |
| The hub's node is not online in `tailscale status` | "<hub> is offline. It may be asleep, shut down, or off Tailscale." | Wait; the app tries again |
| The node is online, but nothing answers on the port | "Hobbots on <hub> isn't answering. It may be closed, remote access may be paused or off, or its port changed." | Change address |
| The address now belongs to another node | "<address> is now a different computer." | Change address, or Disconnect |
| Something answers that is not Hobbots | "Something other than Hobbots answers at <address>." | Change address |
| The hub's connect protocol is outside the range | The update messages above | Update the older side |
| `401 DeviceRevoked` | "This Mac was removed from <hub>." | Ask again, or Disconnect |
| `401 DeviceRequired` | "<hub> no longer knows this Mac." | Ask again, or Disconnect |

- **While a page is open,** the hub's own reconnecting banner shows ([design specification](../design/ui-ux.md)), with the reason from this table in place of its generic "may be off or paused" text, and Change address where the table offers it. The page stays, so the open thread and its unsent message stay too.
- **With no page open,** such as on start, or when a page load fails, the window shows the same state as a local page.
- **Trying again.** The app checks again every 5 seconds and at once when the Mac wakes. Each try while the hub is out of reach reads Tailscale afresh, so a change of network or of Tailscale's state is found by the next one. When the hub answers again, the stream reconnects and the page carries on, with the same token and no new approval.
- **A changed port.** While connected, the hub's `remote-access` event carries the new port. The app moves to it, sets the cookies again and reloads the window at the same path, as the hub's own window does today. If the app missed the change, Change address takes the new address. An address on the same node keeps the token, so no new approval is needed, since ADR 021 binds the token to the node and not to the port.
- **HTTPS turned on or off.** Page loads follow the hub's redirect between its HTTP and HTTPS addresses, and both already carry a cookie. When HTTPS turns off and the stored address was the HTTPS one, the app switches to the HTTP address from the same event.
- **Revoked, or unknown to the hub.** The app deletes the keychain item at once. Ask again starts pairing with the same hub. Disconnect forgets the hub.
- **The menu bar** shows "Connected to <hub>" or the state from the table, Open Hobbots and Quit. Quit stops only this app; nothing runs here. Pause remote access and the warning about working hobs belong to the hub and do not show.
- **Notifications** work as on the hub, from the main process with the device token, while the hub is reachable.

### Settings › Devices and Disconnect

- **On a connected desktop,** Settings › Devices shows the hub it uses: its name, address and version, this app's version, and Disconnect. It still lists the approved devices with Revoke, as on any approved device. It does not show remote access, the port or HTTPS, since those change the hub's network from elsewhere and could cut this computer off.
- **Disconnect** asks first. It revokes this device on the hub with the device ID, deletes the keychain item, clears the mode and returns to Where Hobbots runs. When the hub cannot be reached, Disconnect still forgets the hub here and says the device stays listed on <hub> until it is revoked there.

### Development and tests

- **A fake Tailscale on the app too.** The app reads Tailscale behind the same interface as the hub, so tests and development use the fake of #340 with two hubs and a connected desktop.
- **An in-memory keychain** stands in for the OS keychain in tests, as the server's does.
- **Two apps on one computer.** A test starts the connected desktop with its own data folder, so its single-instance lock and settings are its own. Nothing in the app assumes it is the only Hobbots on the computer once it is in connect mode.

## Rationale

Loading the hub's own pages keeps one client for every device. A connected desktop then behaves like a browser that holds its token in the keychain, and it can never show screens that disagree with the hub. The only contract that must hold across versions is the narrow one the main process uses, so that is what the connect protocol counts. A version number alone would either block every mismatch or none.

Showing Welcome and the first setup step as local pages is what lets a connected desktop start with no server and no database. The alternative, starting a server and then removing it when the user chooses Connect, would leave a database and an installation behind on a computer that is meant to hold neither.

Checking the hub's node before sending the token or loading a page costs one `tailscale whois` a minute. It means an address that later points somewhere else gets nothing, and the window never shows pages from a computer the user did not choose. The app cannot prove that the software on that computer is Hobbots, and no answer the hub gives could prove it. So trust rests on what can be checked: Tailscale and WireGuard name the computer, the user chooses it, and the matching code lets them check the prompt they answer. The narrow bridge limits what a wrong choice can cost.

Reading the reason from this computer's Tailscale lets the app tell "your Tailscale is off" from "the hub is asleep" from "Hobbots is closed there", which is the difference between something the user fixes here, something they fix on the other computer, and waiting.

## Consequences

- **#444** builds connect mode in the app: the mode in `desktop-settings.json`, starting with no server for a new installation or a connected desktop, the keychain item, pairing as a desktop with `deviceId` in the claim, the node check, the two window cookies and keeping the hub's cookie refresh out of the window's cookie store, the narrower bridge, the connect protocol in the health answer, the menu bar and notifications in connect mode.
- **#445** finds hubs on the tailnet: the peers' names, online state and owners from `tailscale status`, the health scan and resolving a typed address. The status reader of `apps/server/src/tailscale.ts` grows to return them.
- **#446** builds the local pages Welcome, Where Hobbots runs, Connect and waiting, and Run here starting the server.
- **#447** builds Settings › Devices on a connected desktop and Disconnect.
- **#448** builds the connection states, trying again, following a changed port and HTTPS, and the reconnecting banner's reasons.
- **#449** proves the slice end to end with a fake Tailscale, and records a manual run on two Macs. Each UI issue updates the screen inventory and the design specification for its screens.
- The app's first launch changes for new installations: the server starts after Run here, not before Welcome. An existing hub sees no change.
- The hub's pages run inside the connected desktop's window. They get no more than a browser tab gets, plus the narrow bridge above.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- A new installation shows Welcome and Where Hobbots runs with no server process and no database. Run here starts the server and continues at the remote access step, and an existing hub starts as a hub without asking. Not proven yet: `TC-DP-156`, [#446](https://github.com/otaviobarros/hobbots/issues/446).
- A connected desktop starts with no server process and no database, and its data folder holds only its settings and its window's browser storage. The token is only in the keychain, never in a file, a log or the page. The hub's cookie refresh never reaches the window's cookie store, while unsent messages are still kept. Proven against a fake hub with the in-memory keychain: `[TC-DP-157]`, `[TC-DP-158]`. The claim after Allow carries the device's ID: `[TC-DP-175]`. In the packaged Mac app, with the real keychain, not proven yet: [#449](https://github.com/otaviobarros/hobbots/issues/449).
- After Allow, the window loads the hub's pages with the device cookie, the main process's requests use the bearer token, and the menu bar and notifications follow the hub. The folder picker is not offered in connect mode. Proven against a fake hub and with the preload bridge alone: `[TC-DP-159]`, `[TC-DP-160]`. The menu bar and notifications in the packaged Mac app, not proven yet: [#449](https://github.com/otaviobarros/hobbots/issues/449).
- An address that now belongs to another Tailscale node gets no token and no page. A hub outside the connect protocol range is never paired with, and shows which side to update; a hub of another version inside it works. A fake hub that answers the health check and fabricates an approved status with its own token is trusted only as the node the user chose: it gets no real token, the bridge offers it only the calls listed above, and the waiting screen names the computer by its Tailscale name. Proven against fake hubs with a fake Tailscale lookup: `[TC-DP-161]`, `[TC-DP-162]`, `[TC-DP-174]`. Every request of the window, reloads included, reaches only the hub's two origins on the pinned node, and another port of its host never sees the device cookies: `[TC-DP-176]`. The waiting screen itself is [#446](https://github.com/otaviobarros/hobbots/issues/446)'s.
- With two hubs on a fake tailnet, both are listed by their Tailscale node names; a peer that answers something else, or nothing, is not; tagged peers and other users' peers are not asked; nothing changes Tailscale. A typed short name, port, HTTPS address or tailnet address resolves, and loopback, local network and public addresses are refused before a request is sent. Proven with a fake Tailscale: `[TC-DP-163]`, `[TC-DP-164]`. Against a running Tailscale, not proven yet: [#449](https://github.com/otaviobarros/hobbots/issues/449).
- From Where Hobbots runs, a second app types or picks a hub, waits with the code the hub's prompt shows, and lands on Home after Allow. Deny, an expired request, a throttled request, an unreachable hub and a program that is not Hobbots each say why and let the user try again. Not proven yet: `TC-DP-165`, `TC-DP-166`, [#446](https://github.com/otaviobarros/hobbots/issues/446).
- Settings › Devices on a connected desktop shows the hub it uses and both versions, without remote access, port or HTTPS. Disconnect asks, revokes the device on the hub, deletes the keychain item and returns to Where Hobbots runs; with the hub out of reach it forgets the hub here and says so. Not proven yet: `TC-DP-167`, `TC-DP-168`, [#447](https://github.com/otaviobarros/hobbots/issues/447).
- Tailscale off on this computer, the hub's node offline, Hobbots not answering, an address now on another node, a revoked device and a device the hub no longer knows each show their own reason and action, and a refused device stops trying until the user acts. The hub stopped and started again is reconnected with the same token and no new pairing, and a page open meanwhile shows the reason in its banner and keeps its unsent message. Proven with a fake hub and a fake Tailscale, and in the browser against a hub from source with the bridge stood in: `[TC-DP-169]`, `[TC-DP-170]`. Ask again on a refused device is the waiting screen's, [#446](https://github.com/otaviobarros/hobbots/issues/446); Disconnect is [#447](https://github.com/otaviobarros/hobbots/issues/447)'s. In the packaged Mac app, not proven yet: [#449](https://github.com/otaviobarros/hobbots/issues/449).
- A port changed while connected is followed at once; one changed while away is reached with Change address on the same node, with no new approval, and an address on another computer is refused before anything is sent to it. An HTTPS address falls back to the HTTP one when HTTPS turns off. Proven with a fake hub and a fake Tailscale, and the banner's Change address in the browser: `[TC-DP-171]`. With no page open, Change address needs the local pages of [#446](https://github.com/otaviobarros/hobbots/issues/446).
- The whole slice runs end to end with a fake Tailscale: connect, Allow, Deny, live hobs and threads, hub off and back, changed port, revoke and Disconnect. Work started on the connected desktop runs on the hub, and no hob reads or writes the connected computer's files. Not proven yet: `TC-DP-172`, `TC-DP-173`, [#449](https://github.com/otaviobarros/hobbots/issues/449). On two Macs on a real tailnet, not proven yet: [#449](https://github.com/otaviobarros/hobbots/issues/449).

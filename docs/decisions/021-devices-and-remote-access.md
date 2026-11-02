# ADR 021 — Devices and remote access

Status: **Accepted.** Finishes the device approval and Tailscale parts of [ADR 010](010-desktop-hub.md) and the [deployment contract](../architecture/deployment.md) (DP-004). It is the decision for the remote access slice ([#14](https://github.com/otaviobarros/hobbots/issues/14)). It changes where the user session of [ADR 015](015-approval-lifetimes-and-grants.md) (PE-006) comes from, and adds the hub's tailnet addresses to the hosts [ADR 014](014-tool-policy-and-enforcement.md) always blocks.

## Context

Today the hub listens only on loopback and has no device tokens. Every request to the hub's address is served. Some routes decide approvals, manage grants or change what hobs may do. They accept a request as the user's when its `Origin` is the hub's own, or when it is a read marked same-origin by `Sec-Fetch-Site`. In a checkout they also accept an allowed client origin, such as the Vite dev server's (`HOBBOTS_ALLOWED_ORIGINS`). That check is not authentication. It holds against a sandboxed hob only because the sandbox keeps the hob off the hub's address. The event stream has no check at all.

Remote access opens the hub to the tailnet, so the hub needs to know who is calling. The deployment contract already decided the shape. Tailscale is the MVP route, and tailnet membership is not authentication. Every new device asks once on the hub, including devices on the same Tailscale account and the hub's own browsers. Only the hub's window is trusted without asking. This ADR decides the rest.

Tailscale's behavior here comes from its source code and CLI help: `tailscale status --json`, `tailscale whois --json` and the identity headers `tailscale serve` adds. Vite's comes from its configuration types. None of it is verified against a running Tailscale yet; #340 and #341 do that.

## Decision

### Words used here

- **The hub's window** is the desktop app's own window on the hub.
- **A local request** reaches the hub's main listener from a loopback address. A request that `tailscale serve` forwards is never a local request (below).
- **A tailnet request** comes from a Tailscale peer: directly on the tailnet listener, or through `tailscale serve`.
- **The MagicDNS name** is the hub's name on the tailnet, such as `hub.example.ts.net`. Its HTTP address carries the hub's port; its HTTPS address, through `tailscale serve`, carries none.

### Kinds of device

| Kind | What it is | How it gets its device | Where its credential lives |
|---|---|---|---|
| The hub's window | The desktop app's window on the hub | Without asking, from the window key | A session cookie in the window, set by the app |
| Connected desktop | The desktop app in connect mode on another computer | Asks once | The OS keychain on that computer |
| Browser | Any browser, on the hub or on the tailnet | Asks once | An `HttpOnly` cookie |

Only the hub's window is trusted without asking. No setting or variable makes the hub trust local browsers, in a packaged hub or in a checkout. A browser on the hub asks once like any other, and the hub's window can allow it.

### Tokens

- **A device token** is `hbd_` followed by 32 random bytes from the system's secure random source, in base64url. It is shown to the device once, when it is issued, and never again.
- **Hashed at rest.** The hub stores only the token's SHA-256 hash and looks the hash up directly. A 256-bit random secret needs no salt and no slow hash. The plain token is never written to the database, the event journal, logs or events.
- **Separate.** Device tokens are not runtime, Charm or agent MCP credentials. None of those is ever accepted as a device token.
- **Lifetime.** A token lasts until it is revoked. A browser's cookie lasts 400 days, the longest browsers keep one. The hub sets it again at most once a day while it is used, so only a device left unused for 400 days asks again.
- **Bound to where it was approved.** A device approved over the tailnet records the stable ID of the Tailscale node it asked from. Its token is accepted only in tailnet requests from that node. A device approved in a local request is accepted only in local requests. A copied cookie is useless on another computer. A token from the wrong place is refused like a missing one, and logged.
- **Redaction.** The prefixes `hbd_`, `hbp_` (pairing secrets) and `hbw_` (the window key) join the secret shapes the hub redacts (permissions contract). The request log never records `Cookie`, `Set-Cookie` or `Authorization`.
- **Records.** #338 adds the devices and pairing requests tables in one migration, for SQLite and PostgreSQL. Its number is 0030 or later, since open work holds 0027 to 0029. A device keeps its name, kind, platform, Tailscale identity at approval, when it was approved, its last activity, its token hash and when it was revoked. Last activity is written at most once a minute.

### Where each kind keeps it

- **Browser.** An `HttpOnly`, `SameSite=Strict` cookie with `Path=/` and no `Domain`, so it goes only to the host that set it. Over HTTP it is named `hobbots_device`. Over HTTPS it is named `__Host-hobbots_device` and is `Secure`. Page scripts never see it, and no token ever goes in a URL. The event stream uses the same cookie. A request carrying two device cookies of the same name is refused, so a cookie another host set for a parent domain cannot shadow the real one.
- **Connected desktop.** The app's main process pairs and keeps the token as one item in the OS keychain, through the same keychain access #322 adds for GitHub. Its own requests send it as `Authorization: Bearer`. For the window, the main process sets it as an `HttpOnly` session cookie for the hub's origin in the window's own session. The browser engine never persists it, and the page never reads it. Disconnect in Settings revokes the device on the hub and deletes the keychain item.
- **The hub's window.** On every start the hub writes a fresh window key, `hbw_` and 32 random bytes, to a file only the user can read (mode `0600`) in the Hobbots data folder. The desktop app reads it and sets it as an `HttpOnly` session cookie in its window's session, for the page the window loads. It sends it as `Authorization: Bearer` for its own requests, such as the Inbox reads behind system notifications. The window key is accepted only in local requests. After a server restart, or on any `401 DeviceRequired`, the app reads the key again and sets the cookie again. Settings › Devices shows the window as "This computer's Hobbots window", without Revoke. Quitting the hub ends its key.
- **Cookies are per host, not per port.** A browser sends a `localhost` cookie to every port on `localhost`. A sandboxed hob cannot listen on a port the user's browser reaches: on macOS sandbox-runtime keeps local binding off, and on Linux the sandbox has its own network namespace. Another program of the user's could receive the cookie, but such a program can already read the data folder. For an unsandboxed hob this is checked, not enforced, like its other rules.

### The user session comes from a device

- **Every route needs a device**, except the web client's files, the health endpoint and the pairing routes below. One middleware on every API group and on the event stream reads the token before any handler runs. It is built on Effect's `HttpApiSecurity`: an API key in each of the two cookie names, and a bearer token. The hub sets the cookie with `HttpApiBuilder.securitySetCookie`, passing `SameSite=Strict` explicitly and turning `Secure` off over plain HTTP.
- **`UserSession` names the device.** The middleware provides `UserSession` with the device's ID, name and kind, instead of an origin. It stays the only code that provides it, and the test that fails when other code names it stays. Approvals and grants keep their guarantees: a hob, a Charm or a runtime tool has no device token, so it has no user session.
- **Why a sandboxed hob has no token.** It cannot read the data folder, where the window key is. It cannot read the browsers' cookie stores under the home folder, or the keychain. It cannot reach loopback, and #340 adds the hub's tailnet addresses and its MagicDNS name to the hosts the sandbox and the web tools always block, as ADR 014 blocks loopback. So it cannot even open a pairing request. An unsandboxed hob could read the window key file; for it the rule stays checked, not enforced, as today.
- **A revoked device decides nothing.** Deciding a request, saving a grant and removing one check, in the same transaction as the write, that the device is still approved. A decision that raced a Revoke is refused.
- **Refusals.** No token, an unknown token or one from the wrong place: `401 DeviceRequired`, and the web client shows the pairing screen. A revoked token: `401 DeviceRevoked` (below). Every refusal is logged with the route and peer, never the token.
- **The health endpoint** answers without a device. To a tailnet request it gives only the hub's name and version, for the waiting screen. The installation ID and data folder, which the desktop app checks before using a server, go only to local requests.
- **What goes away.** The origin rule for user sessions, the client origin allow list (`HOBBOTS_ALLOWED_ORIGINS`) and the hub's CORS headers. The event stream becomes a confidentiality boundary for approvals.

### Pairing

1. A device without a token calls `POST /api/pairing` with a name and its platform. A browser suggests a name from its user agent, such as "Safari on iPhone", and the user can change it. The name is untrusted text: at most 64 characters, control characters removed, always shown as plain text.
2. The hub opens a pairing request. It answers with a pairing secret (`hbp_` and 32 random bytes) and a matching code. A browser gets the secret as an `HttpOnly` cookie; the desktop app keeps it in memory. The hub stores only its hash.
3. **The matching code** is six digits from the secure random source, shown as two groups of three, such as `482 913`. It is unique among open requests. It is not a secret and nobody types it. It lets the user see that the prompt on the hub belongs to the device in front of them.
4. The device shows "Waiting for approval on <hub name>" with the code. It asks the hub every 2 seconds whether the request was decided.
5. The hub shows the device's name, what it uses (the Hobbots app or a browser), its Tailscale identity and the same code, with Allow, Deny and Decide later. A request from the hub itself, local or from the hub's own Tailscale node, says "From this computer". The prompt appears in the hub's window, as a system notification, and under Needs you in the Inbox of every approved device. Deciding needs a user session.
6. **Allow** creates the device. The next time the waiting device asks, and only when it presents the pairing secret, the hub hands it its token once, as the device cookie for a browser. The pairing secret then stops working. Someone who only saw the code cannot claim the token.
7. **Deny** ends the request. The device shows "Not allowed on <hub name>" and can ask again after a minute.
8. **Lifetime.** A request expires after 10 minutes. **Decide later** closes the prompt, keeps the request in Settings › Devices and extends it to 24 hours from when it was opened, as pending approvals last (ADR 015). The device keeps waiting. A browser that comes back with its pairing secret returns to the same request. An expired request cannot be allowed: the hub refuses a late Allow, and the device starts over.
9. **Who may ask.** By default only tailnet devices owned by the same Tailscale user as the hub may ask; local requests always may. A tagged device, or one owned by another user (a shared-in device or a teammate's on the same tailnet), is refused with "Only your own devices can ask". Settings › Devices has a switch, off by default, that lets other users' and tagged devices ask too. Their prompt then names the owner or the tags.
10. **Rate limits**, with Effect's `RateLimiter` and its in-memory store. They are keyed by the Tailscale node for a tailnet request, and by "this computer" for a local request:
    - one open request per pairing secret: asking again with the same secret returns it;
    - at most 3 open requests per key, deferred ones included;
    - at most 5 new requests per key in 10 minutes, and none for a minute after a Deny;
    - at most 20 open requests on the hub;
    - at most one status check per second per request;
    - at most 60 requests a minute without a device from one tailnet node, pairing and health included. Status checks that present a valid pairing secret count only toward their own limit, so three waiting screens on one node are never throttled.

    Anything over a limit gets `429` with `Retry-After` and creates nothing, so no prompt or notification. The waiting screen says how long to wait, and that requests still waiting can be decided in Settings › Devices on the hub. The pairing body is at most 1 KB.
11. Pairing changes go into the event journal (a device asked, was allowed, denied or revoked), so every approved client updates live. No token or pairing secret goes in, only the code and the device's details.
12. A hub with no window, such as during development, allows a request from a command in the server package. The command reads the window key from the data folder and takes the matching code. #338 names it.

### Listening on the tailnet

- **Off by default.** Remote access is a setting, off until the user turns it on in setup or Settings › Devices.
- **Learning the address.** While remote access is on, the hub runs `tailscale status --json` every 10 seconds. It uses the tailnet only when `BackendState` is `Running`. It takes the addresses from `Self.TailscaleIPs`, and the MagicDNS name from `Self.DNSName` without its trailing dot. It finds the `tailscale` command on the `PATH`, where the standalone Mac app can install it and Homebrew does, and otherwise runs the Mac app's own binary, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, with `TAILSCALE_BE_CLI=1` so it acts as the command line instead of opening its window. It never changes Tailscale's settings on its own.
- **Binding.** The hub listens on each of its tailnet addresses at its port, beside loopback. It never listens on `0.0.0.0`, `::` or another interface. When Tailscale stops running, loses its addresses or remote access turns off, the hub closes the tailnet listener and its open connections, and Settings › Devices says why. When the addresses change, it binds the new ones.
- **Tailnet peers only.** A connection on the tailnet listener from outside Tailscale's ranges (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`) is closed at once. For the rest, the hub asks `tailscale whois --json` about the peer's address and keeps the answer for a minute. It drops the answer earlier when `tailscale status` no longer lists the peer. A peer Tailscale does not know gets `403`. The answer gives the node's stable ID, its name, and its owner's login or its tags. Pairing uses them for who may ask and for the prompt.
- **Host names.** The check that answers DNS rebinding grows. Besides `localhost`, `127.0.0.1` and `[::1]`, it accepts the MagicDNS name and the tailnet addresses. Any other `Host` gets `421`.
- **A changed port** rebinds both listeners. A connected desktop that loses the hub shows how to enter the new address. When HTTPS is on, the serve listener's port does not change, so `tailscale serve` keeps working.
- **Tests** use a fake Tailscale behind the same interface (#340). It has a status, a tailnet address the test can bind and a whois table, so no test needs a tailnet.

### HTTPS with `tailscale serve`

- **Optional.** Settings › Devices shows the `tailscale serve` command that serves the hub over HTTPS on its MagicDNS name, or runs it in the background after the user consents. Hobbots never runs `tailscale funnel`, and refuses any request that carries `Tailscale-Funnel-Request`, so the hub is never on the public internet.
- **Its own listener.** `tailscale serve` forwards to the loopback address only, on a separate serve port that the hub opens only while HTTPS is on. Every request on the serve listener is a tailnet request, never a local one. The hub reads `Tailscale-User-Login` and `X-Forwarded-For` only there. `X-Forwarded-For` must hold exactly one address, and the hub takes the node from `tailscale whois` on it. Tailscale removes any copy of those headers a client sends. A program of the user's on the hub could connect to the serve port and forge them, but it can already read the data folder.
- **Kept in step with Tailscale.** Tailscale keeps its serve configuration until it is removed. Turning HTTPS or remote access off shows the command that removes it, or runs it with consent. Settings reads `tailscale serve status --json` and says when serve still forwards to the hub after HTTPS was turned off. While remote access is off or paused, the serve listener is closed, so nothing is forwarded.
- **What it changes.** The address and QR code become `https://<MagicDNS name>`. Pages there are a secure context on every device, which browsers need for clipboard and notifications. Tailscale already encrypts the traffic, so HTTPS adds no secrecy on the tailnet. The device cookie becomes `__Host-hobbots_device` with `Secure`. A browser approved over HTTP sends its cookie to the HTTPS address too, so it keeps its device; the hub moves it to the secure cookie on that first request. While HTTPS is on, the HTTP address redirects page loads to the HTTPS address. API requests with a bearer token keep working on it.

### Origins and CSRF

- **One origin per page.** The web client calls the API on its own origin. No route sends CORS headers.
- **Changes need their own origin.** A request carrying the device cookie that is not `GET`, `HEAD` or `OPTIONS` must carry an `Origin` equal to its own origin: `https` on the serve listener and `http` otherwise, with the `Host` it was sent to. Without one, or with another, it gets `403`. This check is the defence. `SameSite=Strict` helps against other sites, but other ports on `localhost` and other devices under the same tailnet domain count as the same site.
- **Reads** carrying the cookie are refused when `Sec-Fetch-Site` says `cross-site` or `same-site`, the event stream included.
- **Pairing.** A pairing request that carries an `Origin` must carry its own. One without `Origin`, as the desktop app's main process sends, is allowed: it carries no device cookie, so there is nothing for it to misuse. Rate limits and who may ask still apply.
- **Bearer requests** skip the `Origin` check: the main process of a connected desktop or of the hub's window, and the allow command. A web page cannot attach the header to a request.

### Revoke and Pause remote access

- **Revoke** in Settings › Devices, from any approved device, asks first. The hub marks the device revoked and keeps its token hash only to recognize it. Within a second its open event streams close. Its next request gets `401 DeviceRevoked`, and that answer clears a browser's cookie. A request already past the middleware may finish, but it cannot decide or grant anything (above). The device shows "This device was removed from <hub name>" with Ask again, which starts pairing. A connected desktop then deletes its keychain item. Revoking the device in use is allowed and ends on that screen. Decisions and grants the device made stay; the user made them.
- **Pause remote access** in the menu-bar icon closes the tailnet and serve listeners and their connections. Local requests keep working, so the hub's window and its browsers are not affected. Pause remote access revokes nothing, survives a restart and lasts until Resume. A device that cannot reach the hub says the hub may be off or remote access paused.
- **Turning remote access off** in Settings does the same and also stops watching Tailscale. Approved devices stay listed and work again once it is back on.

### Development and tests

- **The Vite dev server proxies the API.** `pnpm dev` serves the web client from Vite. Vite forwards `/api`, the event stream included, to the hub on loopback without changing the `Host`. The client calls the API on its own origin, as the built client does, so the cookie and origin rules are the same as in a packaged hub.
- **The first visit in a checkout pairs.** A dev browser asks once like any browser. The user allows it from the hub's window if it runs, or with the allow command and the code.
- **The desktop app's development build** reads the window key like the packaged one, and sets the cookie for the page its window loads, the Vite dev server's or the hub's.
- **The fake runtime** runs inside the hub and is not affected.
- **Browser tests** give each browser context a device without the prompt. The hub fixture uses the window key of the test's own data folder to allow a pairing request, and puts the cookie in the context. API helpers send the window key as a bearer token instead of a forged `Origin`. #343 runs pairing itself end to end through the prompt.

## Rationale

The deployment contract already chose to ask for every browser. This ADR keeps that because it is the only rule that holds against any web page or program that can reach the hub's port on `localhost`. The hub's window is different: the app that runs the hub can read the hub's data folder, so a key there proves it is the app without a prompt.

`HttpOnly` cookies keep tokens away from page scripts, and the event stream needs no token in its URL. An `Origin` check with `SameSite=Strict` is the standard defence for cookie sessions, and dropping CORS removes the one place another origin was trusted. Binding a token to its Tailscale node turns a stolen cookie into nothing, at little cost, since Tailscale already tells the hub who each peer is. A separate serve listener keeps forwarded traffic from ever looking local, so the forwarded identity headers are read only where Tailscale sets them.

The matching code only has to let the user match two screens, so six digits suffice. The pairing secret, not the code, is what claims the token. Short request lives, per-peer limits and asking only from the user's own devices keep one peer from burying the hub in prompts.

Trusting local browsers instead would be simpler in development. It would also trust every local page that reaches the port, and a hob's way around the sandbox would become a user session. Proxying through Vite and an allow command keep development close to the shipped path at a small cost.

## Consequences

- **#338** adds the devices and pairing tables, the device middleware on every route and the event stream, `UserSession` from the device, the revoked-device check inside decisions and grants, the window key, the allow command, the test fixture and the Vite proxy. It removes the origin rule, `HOBBOTS_ALLOWED_ORIGINS` and CORS. The web client's development fallback to `http://127.0.0.1:4317`, `VITE_HOBBOTS_API_URL` and the window's `--hobbots-api` address go too, since the client then calls its own origin. The desktop app's forged `Origin` on its main-process requests becomes the window key.
- **#339** builds pairing: the waiting screen, the prompt on the hub, the notification, the Inbox item, who may ask and the rate limits.
- **#340** builds the Tailscale watcher, the tailnet listener, the peer and host checks, the fake Tailscale, and the hub's tailnet addresses and MagicDNS name in the sandbox's and web tools' blocked hosts. ADR 014's list of always-blocked hosts gains them.
- **#341** builds remote access in setup and Settings › Devices: HTTPS with `tailscale serve`, its own listener, and keeping serve in step.
- **#342** builds Revoke, Pause remote access and what a revoked device, or one that cannot reach a paused hub, sees.
- **#343** proves the slice end to end.
- Every existing browser test and API helper moves from a forged `Origin` to a device. Until #338 lands, the origin rule stays in force.
- A program running as the user on the hub can still act as the user. That was true before, and the sandbox keeps hobs from being such a program.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- A request without a device token, with an unknown one, with one from another Tailscale node or with two device cookies is refused before any handler runs, on every route and the event stream. The database, journal and logs never hold a plain token. Not proven yet: [#338](https://github.com/otaviobarros/hobbots/issues/338).
- The hub's window works on first start without a prompt and again after the server restarts, a browser on the hub asks once, and the window key works only in local requests. Not proven yet: [#338](https://github.com/otaviobarros/hobbots/issues/338).
- Deciding approvals and managing grants needs a device; a script, a web page or a hob's tool call still cannot, and only the device middleware provides a user session. A decision from a device revoked while it ran is refused. Not proven yet: [#338](https://github.com/otaviobarros/hobbots/issues/338), [#342](https://github.com/otaviobarros/hobbots/issues/342).
- A cookie request that changes something without its own `Origin` and a cross-site read are refused. Not proven yet: [#338](https://github.com/otaviobarros/hobbots/issues/338). A request to an unknown `Host` is refused, on loopback and on the tailnet, while the MagicDNS name and the tailnet addresses are accepted: `TC-DP-007`, `TC-DP-068`.
- A browser waits with a code, and after Allow on the hub it works without asking again. Deny lets it ask again after a minute. An expired request cannot be allowed. Only the holder of the pairing secret receives the token. A request from the hub itself says so. Not proven yet: [#339](https://github.com/otaviobarros/hobbots/issues/339).
- A peer over the rate limits gets `429` and creates no prompt, and a device of another Tailscale user is refused unless the switch allows it. Not proven yet: [#339](https://github.com/otaviobarros/hobbots/issues/339).
- With remote access on, the hub listens only on loopback and its tailnet addresses, closes connections from outside Tailscale's ranges, refuses peers Tailscale does not know, and closes the tailnet listener and its connections when Tailscale stops or remote access turns off, saying why in Settings. A changed port reaches every client. Proven with a fake Tailscale: `TC-DP-060` to `TC-DP-067`, `TC-DP-069`, `TC-DP-071` and `TC-DP-072`. Until devices can pair, the hub answers every tailnet request with `403`, so no tailnet browser acts as the user before device tokens exist: `TC-DP-073`. Not verified against a running Tailscale yet, on macOS or Linux: [#343](https://github.com/otaviobarros/hobbots/issues/343).
- A sandboxed hob's command and web tools cannot reach the hub's tailnet addresses or MagicDNS name, so it cannot open a pairing request. The policy engine refuses them by name and by resolved address (`TC-PE-170`, `TC-DP-070`), and the sandbox's proxy already refuses any name that resolves to one of the hub's own interface addresses. Not verified on a hub with a running Tailscale yet: [#343](https://github.com/otaviobarros/hobbots/issues/343).
- From Settings the user turns remote access on, sees the address and QR code, and turns HTTPS on with `tailscale serve` after consenting. A device approved over HTTP keeps working over HTTPS. Forwarded identity headers count only on the serve listener, a funnel request is refused, and Settings says when serve still forwards after HTTPS was turned off. Not proven yet: [#341](https://github.com/otaviobarros/hobbots/issues/341).
- Revoking a device mid-stream closes its stream at once and refuses its next request, and it can ask again. Pause remote access stops tailnet and serve traffic while local requests keep working, and Resume restores it. Not proven yet: [#342](https://github.com/otaviobarros/hobbots/issues/342).
- The whole slice runs with a fake Tailscale on SQLite and PostgreSQL: an unapproved device refused, pairing, Allow, Deny, an expired request, Revoke mid-stream, Tailscale turning off and a changed port. Not proven yet: [#343](https://github.com/otaviobarros/hobbots/issues/343).

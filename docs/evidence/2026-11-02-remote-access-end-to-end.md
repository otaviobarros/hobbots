# Remote access holds end to end over a fake Tailscale

- **Date:** 2026-11-02
- **Issue:** [#343](https://github.com/otaviobarros/hobbots/issues/343)
- **Pull request:** [#421](https://github.com/otaviobarros/hobbots/pull/421)
- **Commit:** not yet on `main` (ran on the pull request branch, based on `0897651`)
- **Setup:** Automated only. At hub level, the hub's own routes and event stream behind its device check, on its real loopback, tailnet and serve listeners, composed as `main.ts` composes them, over a fake Tailscale that serves the tailnet on `127.0.0.2` with the user's phone and laptop at `127.0.0.5` and `127.0.0.6`. The devices are plain HTTP clients that keep the hub's cookies as a browser does, and the clock is moved forward for expiry and the Deny wait. In the browser, a hub from source with `HOBBOTS_FAKE_TAILSCALE=on`, the hub's window in one Chromium context and a tailnet browser in another. The fake runtime throughout. Linux x86_64, Node 22.23.4, Chromium 1243 headless, on SQLite in memory and on PostgreSQL 16; CI runs the hub-level suite on SQLite and PostgreSQL 18 and the browser test on SQLite.
- **Result:** Passed with gaps. An unapproved tailnet device is refused on every route and the event stream, pairing with a matching code, Allow, Deny, Decide later and expiry hold over the tailnet, Revoke and Pause end open streams at once while the hub's window keeps working, Tailscale turning off and a changed port reach every client, and HTTPS through `tailscale serve` keeps an HTTP-approved device working. A real tailnet and the packaged Mac app were not part of this run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-DP-145]` | With remote access on, a tailnet device that was never approved gets `401 DeviceRequired` on reads, changes, pairing decisions and the event stream, with no token, with a token the hub never issued, and with the window key, which counts only on loopback. A peer Tailscale does not know gets `403`. Nothing changed and no device was added. | ✅ |
| `[TC-DP-146]` | A phone on the tailnet asks to pair and waits with a six-digit code. The hub's prompt lists the same code as from another device, and the window's stream hears of it. After Allow the phone claims its token as an `HttpOnly` cookie, never in the body, and reads the API and the stream. Its own token then lets it allow the laptop. Sent from the laptop's node, the phone's token is refused. What the stream carried about pairing held no secret. | ✅ |
| `[TC-DP-147]` | A denied laptop is told so, gets no cookie and cannot be allowed afterwards. Asking again within the minute is `429` with `Retry-After` and adds no prompt; after the minute it opens a new request. | ✅ |
| `[TC-DP-148]` | A request left undecided for 11 minutes is expired and cannot be allowed, while one sent to Decide later is still listed, still pending for its device, and is allowed. | ✅ |
| `[TC-DP-149]` | An approved phone keeps working across reads and after the hub quits and starts again on the same data and database: remote access is still on, the same cookie is accepted on the API and the stream, and no new pairing request appears. | ✅ |
| `[TC-DP-150]` | With the phone's and the laptop's streams open, Revoke from the hub's window ends the phone's stream at once, while the laptop's stays open and hears of it. The phone's next request is `401 DeviceRevoked` and drops its cookie, later ones `DeviceRequired`, its stream is refused, and it can ask again. | ✅ |
| `[TC-DP-151]` | With HTTPS on, Pause ends a stream on the tailnet and one through the serve listener, and both listeners refuse connections. The hub's window keeps working on loopback and hears of the pause. No device is revoked, and after Resume the same cookies work over HTTP and HTTPS. | ✅ |
| `[TC-DP-152]` | Tailscale stopping ends the phone's open stream at the next check and removes the tailnet listener. Settings' read says `problem: "tailscale"` with Tailscale `notRunning`, and the window's stream heard it. Once Tailscale is back the hub listens again and the phone's cookie works. | ✅ |
| `[TC-DP-153]` | A changed port reaches the phone's open stream on the tailnet and the window's, both find the hub on the new port, both old addresses refuse, and the port is kept across a restart. | ✅ |
| `[TC-DP-154]` | After HTTPS is turned on and `tailscale serve` runs with consent, the phone approved over HTTP gets in through serve with the cookie it has and moves to `__Host-hobbots_device`, on the API and the stream. Serve's forwarded identity headers sent to loopback count for nothing, so the phone's node-bound token is refused there; through serve, another node's address and the window key are refused. A Funnel request is `403` on every listener. HTTPS off closes the serve listener and reports that serve still forwards until it is removed. | ✅ |
| `[TC-DP-155]` | Interaction check 10 in the browser: turn on remote access in Settings, open the hub's tailnet address in another browser, which asks and shows a code. The prompt over the hub's window shows the same code, Allow lets the browser in and it stays in after a reload. Revoke in Settings › Devices shows the removed screen at once, and the hub refuses its next read. | ✅ |

## Gaps

- No real Tailscale: the fake serves Tailscale's documented `status`, `whois` and `serve` behaviour on loopback addresses, so a real tailnet on macOS or Linux, real identity headers from `tailscale serve`, and a sandboxed hob that cannot reach the hub's tailnet names are not verified ([#416](https://github.com/otaviobarros/hobbots/issues/416)).
- The packaged Mac app was not part of this run: the prompt over its window and its system notification, the window key across restarts, and Pause from the menu-bar icon were stood in for by the web client with the desktop app's preload faked and by API calls with the window key ([#416](https://github.com/otaviobarros/hobbots/issues/416)).
- The tailnet browser in `[TC-DP-155]` connects from `127.0.0.1`, which the fake names as the laptop, so the browser and the hub's window run on the same machine.
- These checks need every `127.0.0.0/8` address on loopback, as Linux has; macOS skips them unless aliases are added.
- The switch that lets other users' and tagged devices ask is not built yet, so only the owner's own devices were checked.

# Deployment and execution environments

**Decided:** a browser-accessible local server and Electron client/launcher; the same application can run self-hosted in Docker/on a user server. Optional Tailscale or authenticated HTTPS access. SQLite locally and PostgreSQL remotely. Single-user MVP with one active installation and registered executors.

## Local mode

The server owns orchestration, data and runtime connections and serves UI/API at loopback by default. Electron starts/connects to this server and renders the same React experience as a browser. Durable state is not duplicated in Electron. Browser closure does not stop the server. Explicitly resolve whether closing Electron leaves its launched server running, minimizes it or shuts it down; no blanket promise of continued execution after the host process or machine stops.

Use installed, authenticated runtimes through supported adapter paths. Runtime login remains a vendor flow; credentials are not pasted into Hobbots conversation history. Choose application-data paths, port discovery, server ownership/single-instance rules and installers before implementation.

## Self-hosted mode

Run the same core and web client on user-controlled infrastructure. Docker/Compose packaging is planned, not implemented here. The server/scheduler and executors can continue work while the desktop client is closed. PostgreSQL and artifact storage retain authoritative state. Do not ship independently writable installations with real-time sync in the MVP.

## Executors

Advertise executor ID, local/remote kind, platform, runtime/version availability, filesystem/terminal/browser/computer capability evidence, capacity and health. Scheduling requires a matching runtime, permitted resources, verified enforcement and free capacity. Heartbeat loss marks observations unverified and triggers reconciliation; it does not prove the process stopped.

Authenticate executors and use encrypted transport and scoped short-lived execution grants for remote work. Credentials remain on the executor or in an approved secrets provider. Belonging to the same user does not let a remote task silently access the local computer. Exact pairing, revocation, routing defaults and transport require design/evidence.

## Access routes

| Route | Required behavior |
|---|---|
| Loopback | Default binding; validate local client origins and protect privileged operations. |
| Tailscale | Explicit private route; tailnet membership supplements application authentication. |
| Public HTTPS | TLS, authenticated/revocable sessions, origin validation, rate limits and CSRF protections when cookie-based; polished onboarding follows private-access validation. |
| Electron | Same server API, server identity checks and narrow native bridge. |

Do not bind publicly merely because the UI supports remote access. Keep user sessions separate from agent MCP credentials and executor credentials. Remote clients receive only authorized capabilities, not arbitrary filesystem or credential access.

## Electron boundary

Keep privileged process/runtime operations in the server/main process; expose a narrow validated preload bridge for necessary native functions. Use context isolation and renderer restrictions appropriate to current Electron guidance. Render tool output and external pages as untrusted content; they must not acquire native privileges. Exact Electron configuration and packaging need current-doc verification at implementation time.

## Release evidence

Verify browser and Electron observe one installation; runtime detection/auth failures are actionable; disconnect/reconnect and host restart recover records; remote execution returns durable results; revoked sessions/grants fail; backups restore both data and artifact references. Supported OS/architectures and installers remain open until validated.

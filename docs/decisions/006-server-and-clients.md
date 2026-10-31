# ADR 006 — One server for browser, Electron and self-hosting

Status: **Accepted**; refined for the MVP by [ADR 010](010-desktop-hub.md).

## Decision

Make the local server the core application and durable state owner, with React browser and Electron clients. Support self-hosting, optional Tailscale and authenticated HTTPS routes.

## Rationale

The same workspace should be accessible locally and remotely without developing two stateful products.

## Consequences

Loopback by default; remote access requires authenticated, revocable devices. The server runs as a background service ([ADR 010](010-desktop-hub.md)).

## Change control

A deliberate user-directed change should update the relevant specification and supersede this ADR with rationale.

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- The browser and the desktop app use the same server and the same API: `[TC-OP-015]`, `[TC-AG-098]` (browser) and `[TC-EX-008]` (desktop).
- The server answers on loopback only by default and serves the web client next to the API: `[TC-DP-008]`, `[TC-DP-005]`.
- A remote device reaches the hub only after it is approved, and a revoked device is refused at once. Not proven yet: [#14](https://github.com/otaviobarros/hobbots/issues/14).

# ADR 006 — One server for browser, Electron and self-hosting

Status: **Accepted.**

## Decision

Make the local server the core application and durable state owner, with React browser and Electron clients. Support self-hosting, optional Tailscale and authenticated HTTPS routes.

## Rationale

The same workspace should be accessible locally and remotely without developing two stateful products.

## Consequences

Loopback by default; remote access requires authentication and scoped executor authority. Resolve Electron shutdown ownership explicitly.

## Change control

A deliberate user-directed change should update the relevant specification and supersede this ADR with rationale.

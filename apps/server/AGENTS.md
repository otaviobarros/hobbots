# Server app

The server app builds the Layers, starts the hub and exposes HTTP and live events. These rules add to the root [AGENTS.md](../../AGENTS.md).

## Code Review Rules

- The app only composes and exposes (STD-ARCH-005). A business rule added here belongs in its feature package (STD-ARCH-006).
- A record a person writes names them through the request's user session, never a fixed owner (STD-SEC-006).
- Every route but health and pairing answers only an approved device, as a user session ([API and events contract](../../docs/architecture/api-events.md), [threat model](../../docs/threat-model.md)). A new route that skips this is P0. Request bodies are parsed with Effect Schemas (STD-DUP-004).
- Server code returns codes, never display text (STD-I18N-005).
- Work that must outlive a restart is in the database, not in a fiber, queue or schedule (STD-DATA-001).

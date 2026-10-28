# packages/api

Validation slice implemented ([ADR 009](../../docs/decisions/009-toolchain-and-validation-slice.md)): Shared Effect `HttpApi` definition used by the server and the typed web client.

Typed API/event contracts and transport boundary; keep vendor runtime protocols outside the domain.

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Credentials are never stored here.

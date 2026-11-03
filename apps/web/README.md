# apps/web

Validation slice implemented ([ADR 009](../../docs/decisions/009-toolchain-and-validation-slice.md)): Home and the chat workspace. Workbench is not built yet.

React and TypeScript client: Navigator, Chat, Execution and Workbench. Submit commands/read projections from the server.

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Run it with `pnpm --filter @hobbots/web dev` next to the server.

The build has two entries. `index.html` is the hub's pages, served by the hub. `local.html` is setup's local pages, Welcome and Where Hobbots runs with Connect, which the desktop app serves from its own resources before the computer is a hub or connected to one ([ADR 025](../../docs/decisions/025-connected-desktop.md)); they call no API and talk only to the app's setup bridge.

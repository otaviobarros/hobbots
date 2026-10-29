# apps/desktop

Validation slice implemented ([ADR 009](../../docs/decisions/009-toolchain-and-validation-slice.md)).

Electron client and local-server launcher. Native lifecycle and narrowly scoped integration, with no independent durable application state.

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Run it with `pnpm dev:desktop` from the repository root.

`pnpm package:mac` from the repository root builds the web client and the app, then packages an unsigned (ad-hoc signed) `Hobbots.app` for the current architecture into `release/mac-arm64/` (`release/mac/` on Intel) with electron-builder ([`electron-builder.config.mjs`](electron-builder.config.mjs)). The packaged app carries the web client in its resources folder, runs the Claude Code installed on the Mac (Workshop shows it as outdated or missing when it needs updating or installing) and keeps its data in `~/Library/Application Support/Hobbots`. A copy downloaded to another Mac must be approved once in System Settings › Privacy & Security.

The app identifies as `ai.hobbots.app`, with the version from this package's `package.json`, the copyright notice from the electron-builder config and the Apache-2.0 `LICENSE` in its resources folder. Its icon is the Hobbots crest on a night tile, drawn cell by cell for every size by [`scripts/app-icon.ts`](scripts/app-icon.ts); run `pnpm --filter @hobbots/desktop icon` (Node 22.18 or later) after changing the art to regenerate `resources/icon.icns` and `resources/icon.png`.

An app opened from Finder does not inherit shell variables. To try it with the fake runtime, quit Hobbots and stop any server on port 4317 first (the app attaches to a running server), then:

```sh
open --env HOBBOTS_RUNTIME=fake apps/desktop/release/mac-arm64/Hobbots.app
```

On Intel, use `release/mac/Hobbots.app`.

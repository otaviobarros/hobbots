# apps/desktop

Validation slice implemented ([ADR 009](../../docs/decisions/009-toolchain-and-validation-slice.md)).

Electron client and local-server launcher. Native lifecycle and narrowly scoped integration, with no independent durable application state.

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Run it with `pnpm dev:desktop` from the repository root.

`pnpm package:mac` from the repository root builds the web client and the app, then packages an unsigned (ad-hoc signed) `Hobbots.app` for Apple silicon and Intel with electron-builder ([`electron-builder.config.mjs`](electron-builder.config.mjs)). It writes one installer per architecture, `release/Hobbots-<version>-arm64.dmg` and `release/Hobbots-<version>-x64.dmg`, plus the unpacked apps in `release/mac-arm64/` and `release/mac/`. The installer window shows the app beside an Applications shortcut; drag one onto the other to install, or over an older copy to update it. The packaged app carries the web client in its resources folder, runs the Claude Code installed on the Mac, found through the installers' folders and the `PATH` of your login shell (Workshop shows it as outdated, signed out or missing when it needs updating, a sign-in or installing) and keeps its data in `~/Library/Application Support/Hobbots`, outside the app, so replacing the app keeps every thread. A copy downloaded to another Mac must be approved once in System Settings › Privacy & Security.

The app identifies as `ai.hobbots.app`, with the version from this package's `package.json`, the copyright notice from the electron-builder config and the Apache-2.0 `LICENSE` in its resources folder. Its icon is the chief of the hobs (crown, long beard, royal robe and cape, lantern staff) on a starry night tile, drawn cell by cell for every size by [`scripts/app-icon.ts`](scripts/app-icon.ts); run `pnpm --filter @hobbots/desktop icon` (Node 22.18 or later) after changing the art to regenerate `resources/icon.icns` and `resources/icon.png`.

An app opened from Finder does not inherit shell variables. To try it with the fake runtime, quit Hobbots and stop any server on port 4317 first (the app attaches to a running server), then:

```sh
open --env HOBBOTS_RUNTIME=fake apps/desktop/release/mac-arm64/Hobbots.app
```

On Intel, use `release/mac/Hobbots.app`. Packaging for Intel works on Apple silicon, but running that build there needs Rosetta.

Pushing a `v<version>` tag runs the [release workflow](../../.github/workflows/release.yml): it packages both installers on an Apple silicon runner with the tag's version, smoke-tests each one on its own architecture with [`scripts/smoke-test.sh`](scripts/smoke-test.sh) (installed from its `.dmg`, launched with the fake runtime until `/api/health` answers, then quit), and only then attaches both `.dmg` files to the draft GitHub Release for that tag, creating it with generated notes if Release Please has not drafted one. A new tag with a pre-release suffix such as `v0.1.0-rc.1` makes a pre-release. To smoke-test a local build without touching your Hobbots data:

```sh
apps/desktop/scripts/smoke-test.sh apps/desktop/release/mac-arm64/Hobbots.app --user-data-dir="$(mktemp -d)"
```

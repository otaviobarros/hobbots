/**
 * Packages a .deb and an .rpm for x64 and arm64 (see package-app.ts). Building the .rpm needs
 * `rpmbuild` on the host (the `rpm` package on Debian and Ubuntu).
 * Run by `pnpm --filter @hobbots/desktop package:linux` (Node 22.18 or later, for type stripping).
 */
import { packageApp } from "./package-app.ts";

await packageApp("linux", process.argv.slice(2));

/**
 * Packages Hobbots.app and a .dmg for Apple silicon and Intel (see package-app.ts).
 * Run by `pnpm --filter @hobbots/desktop package:mac` (Node 22.18 or later, for type stripping).
 */
import { packageApp } from "./package-app.ts";

await packageApp("darwin", process.argv.slice(2));

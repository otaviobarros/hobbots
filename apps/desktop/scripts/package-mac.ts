/**
 * Fetches the memory engine for both architectures (ADR 028), packages the macOS app, then checks
 * its fuses (STD-DESKTOP-007). Every argument goes to
 * electron-builder, as `pnpm package:mac -c.extraMetadata.version=1.2.3` does in the release workflow,
 * and the fuse check runs only once the build succeeded.
 * Run by `pnpm --filter @hobbots/desktop package:mac` (Node 22.18 or later, for type stripping).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkFuses } from "./check-fuses.ts";

const run = (command: string, args: ReadonlyArray<string>) => {
  const { status, error } = spawnSync(command, args, { stdio: "inherit", cwd: join(import.meta.dirname, "..") });
  if (error !== undefined) throw error;
  if (status !== 0) process.exit(status ?? 1);
};

// Each architecture's installer carries its own engine, checked against the pinned release.
const fetchEngine = join(import.meta.dirname, "../../../packages/memory/scripts/fetch-engine.ts");
for (const target of ["darwin-arm64", "darwin-x64"]) run(process.execPath, [fetchEngine, "--target", target]);

run("electron-builder", [
  "--mac",
  "--config",
  "electron-builder.config.mjs",
  "--publish",
  "never",
  ...process.argv.slice(2),
]);
if (!(await checkFuses(join(import.meta.dirname, "../release")))) process.exit(1);

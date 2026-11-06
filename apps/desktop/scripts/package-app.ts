/**
 * Packages the app for one platform: fetches the memory engine for each of its architectures
 * (ADR 028), runs electron-builder, then checks the fuses of every app it built (STD-DESKTOP-007).
 * Every extra argument goes to electron-builder, as `pnpm package:mac -c.extraMetadata.version=1.2.3`
 * does in the release workflow, and the fuse check runs only once the build succeeded.
 * Used by package-mac.ts and package-linux.ts (Node 22.18 or later, for type stripping).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkFuses } from "./check-fuses.ts";

const run = (command: string, args: ReadonlyArray<string>) => {
  const { status, error } = spawnSync(command, args, { stdio: "inherit", cwd: join(import.meta.dirname, "..") });
  if (error !== undefined) throw error;
  if (status !== 0) process.exit(status ?? 1);
};

export const packageApp = async (platform: "darwin" | "linux", builderArguments: ReadonlyArray<string>) => {
  // Each architecture's package carries its own engine, checked against the pinned release.
  const fetchEngine = join(import.meta.dirname, "../../../packages/memory/scripts/fetch-engine.ts");
  for (const arch of ["arm64", "x64"]) run(process.execPath, [fetchEngine, "--target", `${platform}-${arch}`]);

  run("electron-builder", [
    platform === "darwin" ? "--mac" : "--linux",
    "--config",
    "electron-builder.config.mjs",
    "--publish",
    "never",
    ...builderArguments,
  ]);
  if (!(await checkFuses(join(import.meta.dirname, "../release")))) process.exit(1);
};

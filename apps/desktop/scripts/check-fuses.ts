/**
 * Reads the fuses of every app `package:mac` or `package:linux` built under release/ and fails on any
 * that differs from `electronFuses` (STD-DESKTOP-007), so a packaging change can never quietly ship
 * the defaults. scripts/package-app.ts runs it after each build.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentFuseWire } from "@electron/fuses";
import { fuseProblems } from "./electron-fuses.ts";

/**
 * A packaged app below release/: a macOS bundle that is not inside another one, such as a helper
 * app, or the executable of a Linux build in its `linux-unpacked` or `linux-<arch>-unpacked` folder.
 */
export const isPackagedApp = (path: string) =>
  (path.endsWith(".app") && !path.slice(0, -4).includes(".app")) ||
  // `hobbots` is `linux.executableName` in electron-builder.config.mjs.
  /^linux(-[a-z0-9]+)?-unpacked\/hobbots$/.test(path);

/** Checks every app under `release`; answers whether all of them have the expected fuses. */
export const checkFuses = async (release: string): Promise<boolean> => {
  const apps = (await readdir(release, { recursive: true }).catch(() => []))
    .filter(isPackagedApp)
    .map((path) => join(release, path));
  if (apps.length === 0) {
    console.error(`No packaged app found in ${release}.`);
    return false;
  }
  let ok = true;
  for (const app of apps) {
    const problems = fuseProblems(await getCurrentFuseWire(app));
    if (problems.length === 0) console.log(`Fuses are as expected in ${app}.`);
    else {
      ok = false;
      console.error(`Wrong fuses in ${app}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    }
  }
  return ok;
};

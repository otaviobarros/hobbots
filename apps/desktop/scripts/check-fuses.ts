/**
 * Reads the fuses of every app `package:mac` built under release/ and fails on any that differs from
 * `electronFuses` (STD-DESKTOP-007), so a packaging change can never quietly ship the defaults.
 * scripts/package-mac.ts runs it after each build.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentFuseWire } from "@electron/fuses";
import { fuseProblems } from "./electron-fuses.ts";

/** Checks every app under `release`; answers whether all of them have the expected fuses. */
export const checkFuses = async (release: string): Promise<boolean> => {
  const apps = (await readdir(release, { recursive: true }).catch(() => []))
    .filter((path) => path.endsWith(".app") && !path.slice(0, -4).includes(".app"))
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

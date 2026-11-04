/**
 * Reads the fuses of every app `package:mac` built under release/ and fails on any that differs from
 * `electronFuses` (STD-DESKTOP-007), so a packaging change can never quietly ship the defaults.
 * Run by scripts/package-mac.ts after each build (Node 22.18 or later, for type stripping).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentFuseWire } from "@electron/fuses";
import { fuseProblems } from "./electron-fuses.ts";

const release = join(import.meta.dirname, "../release");
const apps = (await readdir(release, { recursive: true }))
  .filter((path) => path.endsWith(".app") && !path.slice(0, -4).includes(".app"))
  .map((path) => join(release, path));

if (apps.length === 0) {
  console.error(`No packaged app found in ${release}.`);
  process.exit(1);
}
let failed = false;
for (const app of apps) {
  const problems = fuseProblems(await getCurrentFuseWire(app));
  if (problems.length === 0) console.log(`Fuses are as expected in ${app}.`);
  else {
    failed = true;
    console.error(`Wrong fuses in ${app}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}
if (failed) process.exit(1);

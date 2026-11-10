#!/usr/bin/env node
// Runs the implicit-state check (STD-ARCH-013) on the hub's packages and the server: no undeclared
// machine in a Set or Map, and no machine's state compared outside the module that declares it.
// Usage: node scripts/check-implicit-state.mjs [--shrink-baseline]
//
// scripts/implicit-state-baseline.json lists what main had when the check was turned on, per file. It
// passes until fixed, and the list only shrinks: --shrink-baseline lowers it to what is left. A new
// case fails, in a listed file too.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { applyBaseline, shrinkBaseline } from "./frontend.mjs";
import { check } from "./implicit-state.mjs";
import { loadMachines } from "./machine-registry.mjs";

const BASELINE = new URL("./implicit-state-baseline.json", import.meta.url);

const files = execFileSync("git", ["ls-files", "packages", "apps/server/src"], { encoding: "utf8" })
  .split("\n")
  .filter(
    (file) =>
      /^(?:packages\/[^/]+\/src|apps\/server\/src)\//.test(file) &&
      /\.ts$/.test(file) &&
      !/\.test\.ts$/.test(file) &&
      !/\/(?:fake|testing)[^/]*\.ts$/.test(file),
  );

const machines = (
  await loadMachines().catch((error) => {
    console.error(`Machines could not be read: ${error.message}`);
    process.exit(1);
  })
).map(({ exportName, machine, module }) => ({
  name: machine.name,
  exportName,
  field: machine.field,
  states: machine.states,
  module,
}));
const found = check(files, (file) => readFileSync(file, "utf8"), machines);
const shrink = process.argv.includes("--shrink-baseline");
const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

if (shrink) {
  writeFileSync(BASELINE, `${JSON.stringify(shrinkBaseline(found, baseline), null, 2)}\n`);
  console.log("Implicit-state baseline lowered to the cases that are left.");
}

const errors = applyBaseline(found, shrink ? shrinkBaseline(found, baseline) : baseline).map((error) =>
  error.replace("check-frontend.mjs", "check-implicit-state.mjs"),
);
if (errors.length > 0) {
  console.error(`Implicit-state check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Implicit-state check passed: ${files.length} files.`);
}

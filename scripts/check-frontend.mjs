#!/usr/bin/env node
// Runs the file-level frontend checks on the web client, the UI package and the desktop app.
// Usage: node scripts/check-frontend.mjs [--shrink-baseline]
//
// scripts/frontend-baseline.json lists the problems that main had when a check was turned on, per
// rule and file. They pass until fixed, and the list only shrinks: --shrink-baseline lowers it to
// what is left. A new problem fails, in a listed file too.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { applyBaseline, check, shrinkBaseline } from "./frontend.mjs";

const BASELINE = new URL("./frontend-baseline.json", import.meta.url);

const files = execFileSync("git", ["ls-files", "apps/web/src", "packages/ui/src", "apps/desktop/src"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith("routeTree.gen.ts"));

const found = check(files, (file) => readFileSync(file, "utf8"));
const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

if (process.argv.includes("--shrink-baseline")) {
  writeFileSync(BASELINE, `${JSON.stringify(shrinkBaseline(found, baseline), null, 2)}\n`);
  console.log("Frontend baseline lowered to the problems that are left.");
}

const errors = applyBaseline(
  found,
  process.argv.includes("--shrink-baseline") ? shrinkBaseline(found, baseline) : baseline,
);
if (errors.length > 0) {
  console.error(`Frontend check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  // Setting the code instead of exiting lets a long list reach a piped stderr in full.
  process.exitCode = 1;
} else {
  console.log(`Frontend check passed: ${files.length} files.`);
}

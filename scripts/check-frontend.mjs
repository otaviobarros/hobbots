#!/usr/bin/env node
// Runs the file-level frontend checks on the web client and the UI package.
// Usage: node scripts/check-frontend.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { check } from "./frontend.mjs";

const files = execFileSync("git", ["ls-files", "apps/web/src", "packages/ui/src"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith("routeTree.gen.ts"));

const errors = check(files, (file) => readFileSync(file, "utf8"));
if (errors.length > 0) {
  console.error(`Frontend check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exit(1);
}
console.log(`Frontend check passed: ${files.length} files.`);

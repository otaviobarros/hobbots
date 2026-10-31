#!/usr/bin/env node
// Fails when a function's cyclomatic complexity is above the limit (STD-ARCH-012).
// Usage: node scripts/check-complexity.mjs [files...]
// With no files, it checks every tracked JavaScript and TypeScript file that Biome checks.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { check } from "./complexity.mjs";

const MAX = 15;
const SOURCE = /\.(c|m)?[jt]sx?$/;
const SKIPPED = [/^docs\//, /^\.agents\/skills\//, /(^|\/)routeTree\.gen\.ts$/];

const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => SOURCE.test(file) && !SKIPPED.some((pattern) => pattern.test(file)));

const files = process.argv.length > 2 ? process.argv.slice(2) : tracked();
let failures = 0;
for (const file of files) {
  for (const { line, message } of check(file, readFileSync(file, "utf8"), MAX)) {
    console.error(`${file}:${line} ${message}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} complexity problem(s). Split the function, or add "// complexity-ignore: <reason>" above it.`,
  );
  process.exit(1);
}
console.log(`Complexity check passed: ${files.length} files, max ${MAX}.`);

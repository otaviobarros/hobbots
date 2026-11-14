#!/usr/bin/env node
// Runs the speaker check (STD-ARCH-021) on the hub's agents and the server: a thread's `agentId`
// names who the camp belongs to, never who speaks. See scripts/speaker.mjs for what it reads.
// Usage: node scripts/check-speaker.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { check, isChecked } from "./speaker.mjs";

const files = execFileSync("git", ["ls-files", "packages/agents/src", "apps/server/src"], { encoding: "utf8" }).split(
  "\n",
);
const errors = check(files, (file) => readFileSync(file, "utf8"));
if (errors.length > 0) {
  console.error(`Speaker check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Speaker check passed: ${files.filter(isChecked).length} files.`);
}

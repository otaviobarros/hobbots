#!/usr/bin/env node
// Runs the speaker check (STD-ARCH-021) on the hub's agents and the server: a thread's `agentId`
// names who the camp belongs to, never who speaks. See scripts/speaker.mjs for what it reads.
// Usage: node scripts/check-speaker.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { check, isChecked } from "./speaker.mjs";

// Tracked files still on disk: one deleted before it is staged is gone, and a new one counts once added.
const files = execFileSync("git", ["ls-files", "packages/agents/src", "apps/server/src"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => file !== "" && existsSync(file));
const errors = check(files, (file) => readFileSync(file, "utf8"));
if (errors.length > 0) {
  console.error(`Speaker check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Speaker check passed: ${files.filter(isChecked).length} files.`);
}

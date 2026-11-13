#!/usr/bin/env node
// Runs the owner-actor check (STD-SEC-006): no code outside the actor's definition, the migrations and
// the session default names `OWNER_ACTOR`. See scripts/owner-actor.mjs for what it reads.
// Usage: node scripts/check-owner-actor.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { check, isChecked } from "./owner-actor.mjs";

const files = execFileSync("git", ["ls-files", "packages", "apps"], { encoding: "utf8" }).split("\n");
const errors = check(files, (file) => readFileSync(file, "utf8"));
if (errors.length > 0) {
  console.error(`Owner-actor check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Owner-actor check passed: ${files.filter(isChecked).length} files.`);
}

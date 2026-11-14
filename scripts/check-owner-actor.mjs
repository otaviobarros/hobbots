#!/usr/bin/env node
// Runs the actor checks: no code outside the actor's definition, the migrations and the session
// default names `OWNER_ACTOR` (STD-SEC-006), and no record says who did something with a bare user
// or hob id (STD-ARCH-020). See scripts/owner-actor.mjs for what they read.
// Usage: node scripts/check-owner-actor.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { check, checkRecords, isChecked } from "./owner-actor.mjs";

const files = execFileSync("git", ["ls-files", "packages", "apps"], { encoding: "utf8" }).split("\n");
const read = (file) => readFileSync(file, "utf8");
const errors = [...check(files, read), ...checkRecords(files, read)];
if (errors.length > 0) {
  console.error(`Actor check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Actor check passed: ${files.filter(isChecked).length} files.`);
}

#!/usr/bin/env node
// Runs the Markdown check: code reads Markdown only through the CommonMark parser, never by hand
// (STD-DUP-008). See scripts/markdown.mjs for what it reads.
// Usage: node scripts/check-markdown.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { check, isChecked } from "./markdown.mjs";

const files = execFileSync("git", ["ls-files", "packages", "apps"], { encoding: "utf8" }).split("\n");
const errors = check(files, (file) => readFileSync(file, "utf8"));
if (errors.length > 0) {
  console.error(`Markdown check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Markdown check passed: ${files.filter(isChecked).length} files.`);
}

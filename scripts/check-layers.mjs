#!/usr/bin/env node
// Checks that each workspace package declares only the packages its layer allows (STD-ARCH-001).
// Usage: node scripts/check-layers.mjs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check } from "./layers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const packages = {};
for (const group of ["apps", "packages"]) {
  for (const dir of readdirSync(`${root}${group}`)) {
    const file = `${root}${group}/${dir}/package.json`;
    if (existsSync(file)) packages[`${group}/${dir}`] = JSON.parse(readFileSync(file, "utf8"));
  }
}

const errors = check(packages);
if (errors.length > 0) {
  console.error(`Layer check failed (STD-ARCH-001):\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exit(1);
}
console.log(`Layer check passed: ${Object.keys(packages).length} packages.`);

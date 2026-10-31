#!/usr/bin/env node
// Checks that docs/standards/README.md indexes every rule in the area files, and nothing else.
// Usage: node scripts/check-standards.mjs

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../docs/standards/", import.meta.url));
const heading = /^### (STD-([A-Z0-9]+)-\d{3}) (.+)$/;
const row = /^\| (STD-([A-Z0-9]+)-\d{3}) \| (.+?) \| (Active|Retired) \|$/;
const prefixFile = /^\| `STD-([A-Z0-9]+)` \| .+ \| \[.+\]\((.+\.md)\) \|$/;

const errors = [];
const index = new Map();
const files = new Map();

for (const line of readFileSync(`${dir}README.md`, "utf8").split("\n")) {
  const prefix = line.match(prefixFile);
  if (prefix) files.set(prefix[2], prefix[1]);
  const entry = line.match(row);
  if (!entry) continue;
  const [, id, , title, status] = entry;
  if (index.has(id)) errors.push(`${id} appears twice in the index`);
  index.set(id, { title, status });
}

const rules = new Map();
for (const file of readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md")) {
  for (const line of readFileSync(`${dir}${file}`, "utf8").split("\n")) {
    const match = line.match(heading);
    if (!match) continue;
    const [, id, area, title] = match;
    if (rules.has(id)) errors.push(`${id} is defined in both ${rules.get(id).file} and ${file}`);
    rules.set(id, { title, file });
    if (files.get(file) !== area) errors.push(`${id} belongs in the file for STD-${area}, not ${file}`);

    const entry = index.get(id);
    if (!entry) errors.push(`${id} (${file}) is missing from the index`);
    else if (entry.status === "Retired") errors.push(`${id} is retired and must not come back in ${file}`);
    else if (entry.title !== title) errors.push(`${id} title differs: index "${entry.title}", ${file} "${title}"`);
  }
}

for (const [id, { status }] of index) {
  if (status === "Active" && !rules.has(id)) errors.push(`${id} is in the index but no area file defines it`);
}

if (errors.length > 0) {
  console.error(`Standards index check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exit(1);
}
console.log(`Standards index check passed: ${rules.size} rules.`);

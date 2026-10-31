#!/usr/bin/env node
// Checks the rules that docs can be checked against:
// - docs/standards/README.md indexes every rule in the area files, and nothing else.
// - Every ADR ends with a Validation section that lists scenarios (STD-DOCS-009).
// - Every evidence record has its fields, and docs/STATUS.md links it (STD-DOCS-010).
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

const decisionsDir = fileURLToPath(new URL("../docs/decisions/", import.meta.url));
const adrs = readdirSync(decisionsDir).filter((name) => /^\d{3}-.+\.md$/.test(name));
for (const file of adrs) {
  const sections = readFileSync(`${decisionsDir}${file}`, "utf8").split(/^## /m);
  const last = sections.at(-1);
  if (sections.length < 2 || !last.startsWith("Validation\n")) {
    errors.push(`ADR ${file} must end with a "## Validation" section (STD-DOCS-009)`);
  } else if (!/^- \S/m.test(last)) {
    errors.push(`ADR ${file} lists no validation scenario (STD-DOCS-009)`);
  }
}

const evidenceDir = fileURLToPath(new URL("../docs/evidence/", import.meta.url));
const status = readFileSync(fileURLToPath(new URL("../docs/STATUS.md", import.meta.url)), "utf8");
const evidenceFields = ["Date", "Issue", "Pull request", "Commit", "Setup", "Result"];
const records = readdirSync(evidenceDir).filter((name) => name !== "README.md" && name.endsWith(".md"));
for (const file of records) {
  const date = file.match(/^(\d{4}-\d{2}-\d{2})-[a-z0-9-]+\.md$/);
  if (!date) {
    errors.push(`evidence record ${file} must be named YYYY-MM-DD-<short-name>.md (STD-DOCS-010)`);
    continue;
  }
  const text = readFileSync(`${evidenceDir}${file}`, "utf8");
  for (const field of evidenceFields) {
    if (!text.includes(`\n- **${field}:** `))
      errors.push(`evidence record ${file} is missing "${field}" (STD-DOCS-010)`);
  }
  if (!text.includes(`\n- **Date:** ${date[1]}\n`))
    errors.push(`evidence record ${file} has a Date that differs from its name`);
  if (!status.includes(`(evidence/${file}`))
    errors.push(`docs/STATUS.md does not link evidence record ${file} (STD-DOCS-010)`);
}

if (errors.length > 0) {
  console.error(`Standards check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exit(1);
}
console.log(`Standards check passed: ${rules.size} rules, ${adrs.length} ADRs, ${records.length} evidence records.`);

#!/usr/bin/env node
// Makes the repository's labels match .github/labels.json.
// Requires the GitHub CLI (`gh`) logged in with write access to the repository.
// Usage: node scripts/sync-labels.mjs [owner/repo] [--prune]
// A label listed under "aliases" is renamed, so issues keep it. --prune deletes labels not in the file.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const prune = args.includes("--prune");
const repo = args.find((arg) => !arg.startsWith("--")) ?? "otaviobarros/hobbots";

const gh = (...ghArgs) => execFileSync("gh", ghArgs, { encoding: "utf8" });
const api = (method, path, fields = {}) =>
  gh("api", "-X", method, path, ...Object.entries(fields).flatMap(([key, value]) => ["-f", `${key}=${value}`]));

const wanted = JSON.parse(readFileSync(new URL("../.github/labels.json", import.meta.url), "utf8"));
const existing = new Map(
  JSON.parse(gh("api", "--paginate", `repos/${repo}/labels?per_page=100`)).map((label) => [label.name, label]),
);

for (const label of wanted) {
  const fields = { new_name: label.name, color: label.color, description: label.description };
  const current = existing.get(label.name) ?? label.aliases?.map((alias) => existing.get(alias)).find(Boolean);
  if (current) {
    api("PATCH", `repos/${repo}/labels/${encodeURIComponent(current.name)}`, fields);
    existing.delete(current.name);
    console.log(current.name === label.name ? `updated ${label.name}` : `renamed ${current.name} -> ${label.name}`);
  } else {
    api("POST", `repos/${repo}/labels`, { name: label.name, color: label.color, description: label.description });
    console.log(`created ${label.name}`);
  }
}

for (const name of existing.keys()) {
  if (prune) {
    api("DELETE", `repos/${repo}/labels/${encodeURIComponent(name)}`);
    console.log(`deleted ${name}`);
  } else {
    console.log(`kept ${name} (not in labels.json; pass --prune to delete)`);
  }
}

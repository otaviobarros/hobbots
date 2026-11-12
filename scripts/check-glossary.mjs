#!/usr/bin/env node
// Runs the glossary check (STD-DOCS-011): the UI's words and the code's names stay as the "Words and
// code names" table of docs/product/glossary.md says. See scripts/glossary.mjs for what it reads.
// Usage: node scripts/check-glossary.mjs [--shrink-baseline]
//
// scripts/glossary-baseline.json lists the copy main had when the check was turned on, per file. It
// passes until fixed, and the list only shrinks: --shrink-baseline lowers it to what is left. A new
// case fails, in a listed file too.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { applyBaseline, shrinkBaseline } from "./frontend.mjs";
import { checkCopy, checkDoc, checkTable, copyOf, exportsOf, parseGlossary } from "./glossary.mjs";

const BASELINE = new URL("./glossary-baseline.json", import.meta.url);
const GLOSSARY = "docs/product/glossary.md";

const tracked = execFileSync("git", ["ls-files", "packages", "apps", "docs"], { encoding: "utf8" }).split("\n");
const read = (file) => readFileSync(file, "utf8");

const rows = parseGlossary(read(GLOSSARY));
const sources = tracked.filter(
  (file) =>
    /^(?:packages\/[^/]+\/src|apps\/server\/src)\//.test(file) && /\.ts$/.test(file) && !/\.test\.ts$/.test(file),
);
const modules = tracked.filter((file) => /^apps\/(?:web|desktop)\/src\/(?:.+\/)?messages\.ts$/.test(file));
// ADRs and evidence records are history and stay as written; the glossary names the words it retires.
const docs = tracked.filter(
  (file) => /^docs\/.+\.md$/.test(file) && !/^docs\/(?:decisions|evidence)\//.test(file) && file !== GLOSSARY,
);

const exported = new Set(sources.flatMap((file) => exportsOf(read(file))));
const copies = modules.map((file) => ({ file, copy: copyOf(file, read(file)) }));
const found = [
  ...checkTable(
    rows,
    exported,
    copies.flatMap(({ copy }) => copy),
  ),
  ...copies.flatMap(({ file, copy }) => checkCopy(file, copy, rows)),
  ...docs.flatMap((file) => checkDoc(file, read(file), rows)),
];

const shrink = process.argv.includes("--shrink-baseline");
const baseline = JSON.parse(read(BASELINE));
if (shrink) {
  writeFileSync(BASELINE, `${JSON.stringify(shrinkBaseline(found, baseline), null, 2)}\n`);
  console.log("Glossary baseline lowered to the cases that are left.");
}

const errors = applyBaseline(found, shrink ? shrinkBaseline(found, baseline) : baseline).map((error) =>
  error.replace("check-frontend.mjs", "check-glossary.mjs"),
);
if (errors.length > 0) {
  console.error(
    `Glossary check failed (see ${GLOSSARY}, "Words and code names"):\n${errors.map((error) => `- ${error}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(`Glossary check passed: ${rows.length} terms, ${modules.length} message modules, ${docs.length} docs.`);
}

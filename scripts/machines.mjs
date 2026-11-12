#!/usr/bin/env node
// Writes a Mermaid diagram of each machine into docs/architecture/machines/, from the table the
// machine exports (ADR 037, STD-ARCH-013), so the diagrams never drift from the code.
// Usage: node scripts/machines.mjs [--check]
//
// --check writes nothing and fails when a diagram is missing, out of date or names no machine.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { diagramProblems, kebab, render } from "./machine-diagrams.mjs";
import { loadMachines } from "./machine-registry.mjs";

const DIR = new URL("../docs/architecture/machines/", import.meta.url);

const machines = await loadMachines().catch((error) => {
  console.error(`Machines could not be read: ${error.message}`);
  process.exit(1);
});
const pages = new Map(machines.map((entry) => [`${kebab(entry.machine.name)}.md`, render(entry)]));
const existing = (() => {
  try {
    return readdirSync(DIR).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
})();

if (process.argv.includes("--check")) {
  const problems = diagramProblems(pages, existing, (file) => readFileSync(new URL(file, DIR), "utf8"));
  if (problems.length > 0) {
    console.error(
      `Machine diagrams check failed (run pnpm docs:machines):\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Machine diagrams check passed: ${pages.size} machines.`);
  }
} else {
  mkdirSync(DIR, { recursive: true });
  for (const file of existing) if (!pages.has(file)) rmSync(new URL(file, DIR));
  for (const [file, text] of pages) writeFileSync(new URL(file, DIR), text);
  console.log(`Wrote ${pages.size} machine diagrams to docs/architecture/machines/.`);
}

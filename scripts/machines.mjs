#!/usr/bin/env node
// Writes a Mermaid diagram of each machine into docs/architecture/machines/, from the table the
// machine exports (ADR 037, STD-ARCH-013), so the diagrams never drift from the code.
// Usage: node scripts/machines.mjs [--check]
//
// --check writes nothing and fails when a diagram is missing, out of date or names no machine.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadMachines } from "./machine-registry.mjs";

const DIR = new URL("../docs/architecture/machines/", import.meta.url);

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** The page for one machine: its diagram and its table of events. */
export const render = ({ exportName, machine, module }) => {
  const lines = ["stateDiagram-v2"];
  for (const row of machine.table) {
    for (const from of row.from) lines.push(`  ${from} --> ${row.to}: ${row.event}${row.guarded ? " (guarded)" : ""}`);
  }
  const leaves = machine.states.filter((state) => !machine.table.some((row) => row.from.includes(state)));
  for (const state of leaves) lines.push(`  ${state} --> [*]`);
  const rows = machine.table.map(
    (row) => `| ${row.event} | ${row.from.join(", ")} | ${row.to} | ${row.guarded ? "yes" : "no"} |`,
  );
  return [
    `# ${machine.name}`,
    "",
    `Written by \`scripts/machines.mjs\` from \`${exportName}\` in \`${module}\`. Do not edit it by hand: change the machine and run \`pnpm docs:machines\`.`,
    "",
    `States, in its \`${machine.field}\` field: ${machine.states.map((state) => `\`${state}\``).join(", ")}.`,
    "",
    "```mermaid",
    ...lines,
    "```",
    "",
    "| Event | From | To | Guarded |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

const machines = await loadMachines();
const pages = new Map(machines.map((entry) => [`${kebab(entry.machine.name)}.md`, render(entry)]));
const existing = (() => {
  try {
    return readdirSync(DIR).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
})();

if (process.argv.includes("--check")) {
  const problems = [
    ...[...pages].flatMap(([file, text]) => {
      if (!existing.includes(file)) return [`docs/architecture/machines/${file} is missing`];
      return readFileSync(new URL(file, DIR), "utf8") === text
        ? []
        : [`docs/architecture/machines/${file} is out of date`];
    }),
    ...existing.filter((file) => !pages.has(file)).map((file) => `docs/architecture/machines/${file} names no machine`),
  ];
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

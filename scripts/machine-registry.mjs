// The machines Hobbots declares with `defineMachine` (ADR 037, STD-ARCH-013), read from the modules
// that export them. Node strips the TypeScript types, so the tables read here are the ones the code runs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The modules whose exports are searched for machines. A machine declared elsewhere adds its package here. */
const ENTRIES = ["packages/domain/src/index.ts"];

const isMachine = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.name === "string" &&
  typeof value.field === "string" &&
  Array.isArray(value.states) &&
  Array.isArray(value.table) &&
  typeof value.transition === "function";

/** Each machine with the export that holds it and the module that declares it, sorted by name. */
export const loadMachines = async (root = new URL("../", import.meta.url)) => {
  const sources = execFileSync("git", ["ls-files", "packages", "apps/server/src"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file));
  const found = new Map();
  for (const entry of ENTRIES) {
    const module = await import(new URL(entry, root).href);
    for (const [exportName, value] of Object.entries(module)) {
      if (!isMachine(value) || found.has(exportName)) continue;
      const declaration = new RegExp(`export const ${exportName}\\b[^=]*=\\s*defineMachine\\b`);
      const file = sources.find((source) => declaration.test(readFileSync(new URL(source, root), "utf8")));
      if (file === undefined) throw new Error(`No module declares ${exportName} with defineMachine`);
      found.set(exportName, { exportName, machine: value, module: file });
    }
  }
  return [...found.values()].sort((a, b) => a.machine.name.localeCompare(b.machine.name));
};

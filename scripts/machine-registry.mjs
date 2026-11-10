// The machines Hobbots declares with `defineMachine` (ADR 037, STD-ARCH-013), found in every package's
// source and the server's, and read from the modules that declare them. The scripts that use this run
// with Node's type transforms, so the tables read here are the ones the code runs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const isMachine = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.name === "string" &&
  typeof value.field === "string" &&
  Array.isArray(value.states) &&
  typeof value.meanings === "object" &&
  Array.isArray(value.table) &&
  typeof value.transition === "function";

const DECLARED = /\b(export\s+)?const\s+(\w+)\b[^=;]*=\s*defineMachine\s*([<(])/g;

/** The source files a machine may be declared in: the packages' and the server's, without tests. */
export const sourceFiles = (root) =>
  execFileSync("git", ["ls-files", "packages", "apps/server/src"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(
      (file) =>
        /^(?:packages\/[^/]+\/src|apps\/server\/src)\//.test(file) &&
        /\.ts$/.test(file) &&
        !/\.test\.ts$/.test(file) &&
        file !== "packages/domain/src/machine.ts",
    );

/**
 * Each declaration of a machine in `text`, as `{ exportName, exported, typed }`: `typed` when it passes
 * its type arguments, which a missing or extra event needs to fail to compile. Pure, so it is tested
 * without a repository.
 */
export const declarationsIn = (text) =>
  [...text.matchAll(DECLARED)].map((match) => ({
    exportName: match[2],
    exported: match[1] !== undefined,
    typed: match[3] === "<",
  }));

/**
 * Each machine with the export that holds it and the module that declares it, sorted by name. Fails
 * when a machine is not exported, is not a machine at run time, or shares its name with another.
 */
export const loadMachines = async (root = new URL("../", import.meta.url)) => {
  const found = [];
  for (const file of sourceFiles(root)) {
    const declarations = declarationsIn(readFileSync(new URL(file, root), "utf8"));
    if (declarations.length === 0) continue;
    const hidden = declarations.find((declaration) => !declaration.exported);
    if (hidden !== undefined)
      throw new Error(`${file}: export ${hidden.exportName}, so its diagram and checks can read it (STD-ARCH-013)`);
    const untyped = declarations.find((declaration) => !declaration.typed);
    if (untyped !== undefined)
      throw new Error(
        `${file}: give ${untyped.exportName} its type arguments, defineMachine<State, Event, Record, Error>, so a missing or extra event does not compile (STD-ARCH-013)`,
      );
    const module = await import(new URL(file, root).href);
    for (const { exportName } of declarations) {
      if (!isMachine(module[exportName])) throw new Error(`${file}: ${exportName} is not a machine at run time`);
      found.push({ exportName, machine: module[exportName], module: file });
    }
  }
  const byName = new Map();
  for (const entry of found) {
    const other = byName.get(entry.machine.name);
    if (other !== undefined)
      throw new Error(
        `Two machines are named ${entry.machine.name}: ${other.exportName} in ${other.module} and ${entry.exportName} in ${entry.module}`,
      );
    byName.set(entry.machine.name, entry);
  }
  return found.sort((a, b) => a.machine.name.localeCompare(b.machine.name));
};

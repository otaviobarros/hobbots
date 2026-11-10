// The machines Hobbots declares with `defineMachine` (ADR 037, STD-ARCH-013), found in every package's
// source and the server's, and read from the modules that declare them. Node strips the TypeScript
// types, so the tables read here are the ones the code runs. A module that declares a machine, and what
// it imports, must use only erasable TypeScript: no enums or parameter properties.

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

const CALLED = /\bdefineMachine\s*[<(]/g;
const ALIASED = /\bdefineMachine\s+as\s+\w+/;

/**
 * Why `text` uses `defineMachine` in a way the registry cannot read, or undefined. Every call must be
 * the whole value of its own `export const`, so a machine wrapped with helpers, built with
 * `Object.assign`, or made through an alias is refused rather than missed.
 */
export const unreadUse = (text) => {
  if (ALIASED.test(text)) return "imports defineMachine under another name; import it by its own name";
  const calls = [...text.matchAll(CALLED)].length;
  const declared = declarationsIn(text).length;
  if (calls > declared)
    return "calls defineMachine other than as `export const XMachine = defineMachine<…>(…)`; declare the machine on its own and add helpers as separate exports, such as `export const ThreadRun = { ...ThreadRunMachine, isRunning }`";
  return undefined;
};

/**
 * Each machine with the export that holds it and the module that declares it, sorted by name. Fails
 * when a machine is not exported, is declared in a way it cannot read, is not a machine at run time, or
 * shares its name with another.
 */
export const loadMachines = async (root = new URL("../", import.meta.url)) => {
  const found = [];
  for (const file of sourceFiles(root)) {
    const text = readFileSync(new URL(file, root), "utf8");
    const unread = unreadUse(text);
    if (unread !== undefined) throw new Error(`${file}: ${unread} (STD-ARCH-013)`);
    const declarations = declarationsIn(text);
    if (declarations.length === 0) continue;
    const hidden = declarations.find((declaration) => !declaration.exported);
    if (hidden !== undefined)
      throw new Error(`${file}: export ${hidden.exportName}, so its diagram and checks can read it (STD-ARCH-013)`);
    const untyped = declarations.find((declaration) => !declaration.typed);
    if (untyped !== undefined)
      throw new Error(
        `${file}: give ${untyped.exportName} its type arguments, defineMachine<State, Event, Record, Error>, so a missing or extra event does not compile (STD-ARCH-013)`,
      );
    const module = await import(new URL(file, root).href).catch((error) => {
      throw new Error(
        `${file} could not be loaded with Node's type stripping (${error.message}); declare the machine in a module that uses only erasable TypeScript, such as one in @hobbots/domain`,
      );
    });
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

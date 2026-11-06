import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThreadItem } from "./protocol.ts";

/**
 * The skills a finished command read (ADR 029, The use line): Codex loads a skill the model picks by
 * reading its `SKILL.md`, which it reports as a read in the command's actions. A read of a
 * `SKILL.md` right inside one of `roots`, the turn's skill folder, names that skill; any other read,
 * a skill's other files included, names none.
 */
export const skillReadsOf = (item: ThreadItem, roots: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (item.type !== "commandExecution" || item.status !== "completed" || roots.length === 0) return [];
  const names = (item.commandActions ?? []).flatMap((action) => {
    if (action.type !== "read") return [];
    const path = isAbsolute(action.path) ? action.path : resolve(item.cwd, action.path);
    return roots.flatMap((root) => {
      const [name, file, ...rest] = relative(root, path).split(sep);
      return name !== undefined && name !== ".." && name !== "" && file === "SKILL.md" && rest.length === 0
        ? [name]
        : [];
    });
  });
  return [...new Set(names)];
};

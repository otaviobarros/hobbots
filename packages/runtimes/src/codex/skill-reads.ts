import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThreadItem } from "./protocol.ts";

/** A skill Codex loads from outside the turn's folder, as an administrator's settings bring it: its name and `SKILL.md`. */
export interface SkillFile {
  readonly name: string;
  readonly path: string;
}

/**
 * The skills a finished command read (ADR 029, The use line): Codex loads a skill the model picks by
 * reading its `SKILL.md`, which it reports as a read in the command's actions. A read of a
 * `SKILL.md` right inside one of `roots`, the turn's skill folder, names that skill, and so does a read
 * of exactly one of `files`, the organization's skills Codex was let load. Any other read, a skill's
 * other files included, names none.
 */
export const skillReadsOf = (
  item: ThreadItem,
  roots: ReadonlyArray<string>,
  files: ReadonlyArray<SkillFile> = [],
): ReadonlyArray<string> => {
  if (item.type !== "commandExecution" || item.status !== "completed") return [];
  if (roots.length === 0 && files.length === 0) return [];
  const names = (item.commandActions ?? []).flatMap((action) => {
    if (action.type !== "read") return [];
    const path = isAbsolute(action.path) ? action.path : resolve(item.cwd, action.path);
    const mounted = roots.flatMap((root) => {
      const [name, file, ...rest] = relative(root, path).split(sep);
      return name !== undefined && name !== ".." && name !== "" && file === "SKILL.md" && rest.length === 0
        ? [name]
        : [];
    });
    return [...mounted, ...files.filter((one) => one.path === path).map((one) => one.name)];
  });
  return [...new Set(names)];
};

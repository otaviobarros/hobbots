import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThreadItem } from "./protocol.ts";

/** A skill a command read, and where it was loaded from: the turn's folder, or an administrator's settings. */
export interface SkillRead {
  readonly source: "library" | "organization";
  readonly name: string;
}

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
): ReadonlyArray<SkillRead> => {
  if (item.type !== "commandExecution" || item.status !== "completed") return [];
  if (roots.length === 0 && files.length === 0) return [];
  const names = (item.commandActions ?? []).flatMap((action) => {
    if (action.type !== "read") return [];
    const path = isAbsolute(action.path) ? action.path : resolve(item.cwd, action.path);
    const mounted = roots.flatMap((root): ReadonlyArray<SkillRead> => {
      const [name, file, ...rest] = relative(root, path).split(sep);
      return name !== undefined && name !== ".." && name !== "" && file === "SKILL.md" && rest.length === 0
        ? [{ source: "library", name }]
        : [];
    });
    const organization = files
      .filter((one) => one.path === path)
      .map((one): SkillRead => ({ source: "organization", name: one.name }));
    return [...mounted, ...organization];
  });
  const seen = new Set<string>();
  return names.filter((read) => {
    const key = `${read.source}:${read.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

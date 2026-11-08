import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY_SKILL_ROOTS } from "@hobbots/domain";
import { Effect } from "effect";

/**
 * The skill folders a clone holds in `.claude/skills` and `.agents/skills` (ADR 029, #1098): each
 * `<root>/<name>` with a `SKILL.md` file, sorted. It only lists, so Hobbots can offer them: an import
 * reads them from the repository's default branch, never from the clone, whose branch may be any.
 * A symlink is not followed, and a folder that cannot be read holds none.
 */
export const repositorySkillFolders = (checkout: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(async () => {
    const found: Array<string> = [];
    for (const root of REPOSITORY_SKILL_ROOTS) {
      const entries = await readdir(join(checkout, root), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = await lstat(join(checkout, root, entry.name, "SKILL.md")).catch(() => null);
        if (file?.isFile() === true) found.push(`${root}/${entry.name}`);
      }
    }
    return found.sort();
  });

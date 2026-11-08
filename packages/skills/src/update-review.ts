import type { SkillFile, SkillFlag, SkillUpdateFile } from "@hobbots/domain";

/**
 * An update's review (ADR 029, Updates from a source): what it changes against the skill's newest
 * revision, file by file, and the flags it raises. Only what the update changes is flagged, so a
 * script the skill has run all along does not keep every update waiting.
 */

/** Whether a file is a skill's instructions: its `SKILL.md`, or one of a set's. */
export const isInstructions = (path: string): boolean => path === "SKILL.md" || path.endsWith("/SKILL.md");

/** Each file the update adds, removes or changes, in its content or in whether it runs, by path. */
export const fileChangesOf = (
  before: ReadonlyArray<SkillFile>,
  after: ReadonlyArray<SkillFile>,
): ReadonlyArray<SkillUpdateFile> => {
  const old = new Map(before.map((file) => [file.path, file]));
  const now = new Map(after.map((file) => [file.path, file]));
  const changes: Array<SkillUpdateFile> = [];
  for (const file of after) {
    const was = old.get(file.path);
    if (was === undefined) changes.push({ path: file.path, change: "added", mode: file.mode, size: file.size });
    else if (was.sha256 !== file.sha256 || was.mode !== file.mode)
      changes.push({ path: file.path, change: "changed", mode: file.mode, size: file.size });
  }
  for (const file of before) {
    if (!now.has(file.path)) changes.push({ path: file.path, change: "removed", mode: file.mode, size: file.size });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/**
 * The flags an update raises: a script it adds or changes, a URL the skill did not have anywhere, and
 * hidden text in a file it adds or changes. `upstream` are the flags of the upstream content as a whole.
 */
export const raisedFlags = (
  base: ReadonlyArray<SkillFlag>,
  files: ReadonlyArray<SkillUpdateFile>,
  upstream: ReadonlyArray<SkillFlag>,
): ReadonlyArray<SkillFlag> => {
  const touched = new Set(files.flatMap((file) => (file.change === "removed" ? [] : [file.path])));
  const known = new Set(base.flatMap((flag) => (flag._tag === "Url" ? [flag.url] : [])));
  const seen = new Set<string>();
  return upstream.filter((flag) => {
    if (flag._tag === "Url") {
      if (known.has(flag.url) || seen.has(flag.url)) return false;
      seen.add(flag.url);
      return true;
    }
    return touched.has(flag.path);
  });
};

/** The most of one `SKILL.md` a review keeps, in characters; a longer one is cut. */
const INSTRUCTIONS_KEPT_MAX = 200_000;

/** A `SKILL.md` as a review keeps it: its text, cut to `INSTRUCTIONS_KEPT_MAX`, and whether it was cut. */
export const keptInstructions = (text: string | null): { readonly text: string | null; readonly cut: boolean } =>
  text === null || text.length <= INSTRUCTIONS_KEPT_MAX
    ? { text, cut: false }
    : { text: text.slice(0, INSTRUCTIONS_KEPT_MAX), cut: true };

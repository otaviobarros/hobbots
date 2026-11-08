import type { SkillsList } from "@hobbots/api";
import type { SkillFlag, SkillId, SkillUpdate, SkillUpdateFile } from "@hobbots/domain";
import { messages } from "./messages.ts";
import { type HobDirectory, originOf, originText, scopeName } from "./skills-model.ts";

const copy = messages.updates;

/** A `SKILL.md`, at the skill's root or of a skill in a set: its diff shows on its own. */
const isInstructionsPath = (path: string): boolean => path === "SKILL.md" || path.endsWith("/SKILL.md");

/** Whether a skill's revisions come from a Git source: the only kind Hobbots checks for updates. */
export const fromGit = (skill: { readonly sourceId: SkillsList["skills"][number]["sourceId"] }, list: SkillsList) =>
  originOf(skill.sourceId, list.sources)?._tag === "Git";

/** Where a skill updates from, in a few words, as `github.com/acme/skills · main`. */
export const updatesFrom = (sourceId: SkillUpdate["sourceId"], list: SkillsList): string =>
  originText(originOf(sourceId, list.sources));

/** How many skills a check reads: every skill whose revisions come from Git. */
export const gitSkillCount = (list: SkillsList): number => list.skills.filter((skill) => fromGit(skill, list)).length;

/** The places accepting moves to the new revision: each assignment of the skill that is not held. */
export const rolloutOf = (skillId: SkillId, list: SkillsList) =>
  list.assignments.filter((assignment) => assignment.skillId === skillId && !assignment.held);

/** Who gets an update when you accept it, as one line: each place by name, or nobody yet. */
export const whoGetsIt = (skillId: SkillId, list: SkillsList, hobs: HobDirectory): string => {
  const names = rolloutOf(skillId, list).map((assignment) => scopeName(assignment.scope, hobs));
  return names.length === 0 ? copy.nobody : names.join(", ");
};

/** The scope a row names: the skill's first place, or that nobody has it yet. */
export const scopeLineOf = (skillId: SkillId, list: SkillsList, hobs: HobDirectory): string => {
  const first = list.assignments.find((assignment) => assignment.skillId === skillId);
  return first === undefined ? copy.notGiven : scopeName(first.scope, hobs);
};

/** The tag a row shows: the first thing worth a careful look, or Clean. */
export const tagOf = (
  update: Pick<SkillUpdate, "flags">,
): { readonly tone: "needs" | "set"; readonly text: string } => {
  const [first] = update.flags;
  // A clean update shows in the mint of a finished thing, as a set does.
  if (first === undefined) return { tone: "set", text: copy.clean };
  return { tone: "needs", text: flagTag(first) };
};

const flagTag = (flag: SkillFlag): string => {
  switch (flag._tag) {
    case "Script":
      return copy.addsScript;
    case "Url":
      return copy.addsLink;
    case "HiddenText":
      return copy.hiddenText;
  }
};

/** The files beside each `SKILL.md`, each with a short note: a new or changed script says so. */
export const otherFilesOf = (update: Pick<SkillUpdate, "files" | "flags">) => {
  const scripts = new Set(update.flags.filter((flag) => flag._tag === "Script").map((flag) => flag.path));
  return update.files
    .filter((file) => !isInstructionsPath(file.path))
    .map((file: SkillUpdateFile) => ({
      path: file.path,
      note: scripts.has(file.path) ? copy.scriptNote[file.change] : copy.fileNote[file.change],
    }));
};

/** The waiting update of one skill, if any. */
export const updateOf = (updates: ReadonlyArray<SkillUpdate> | undefined, skillId: SkillId): SkillUpdate | null =>
  updates?.find((update) => update.skillId === skillId) ?? null;

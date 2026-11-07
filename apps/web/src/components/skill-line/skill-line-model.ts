import { skillTitle, type UsedSkill } from "@hobbots/domain";
import { memberView, type SkillsView, skillView } from "../skills/skills-model.ts";
import { messages } from "./messages.ts";

/**
 * What one used skill's line says after "Used": its title, then the set it comes from, if any, and its
 * revision (the set's, for a set's skill) or where it came from (ADR 029, The use line).
 */
export const usedLine = (used: UsedSkill): { readonly title: string; readonly detail: string } => {
  const where =
    used.number !== null
      ? messages.revision({ number: used.number })
      : used.source === "organization"
        ? messages.organization
        : "";
  return {
    title: skillTitle(used.name),
    detail: [used.set === null ? "" : messages.fromSet({ set: used.set }), where]
      .filter((part) => part !== "")
      .join(" "),
  };
};

/**
 * Where a used skill's Open goes: its page in the library, or a set's skill's page in its set. An
 * organization's skill has no page here, so its line has no Open.
 */
export const usedPage = (used: UsedSkill): SkillsView | null =>
  used.source !== "library" || used.skillId === null
    ? null
    : used.set === null
      ? skillView(used.skillId)
      : memberView(used.skillId, used.name);

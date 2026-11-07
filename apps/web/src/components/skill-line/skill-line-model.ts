import { skillTitle, type UsedSkill } from "@hobbots/domain";
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

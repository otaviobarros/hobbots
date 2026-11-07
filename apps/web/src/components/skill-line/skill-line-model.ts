import { skillTitle, type UsedSkill } from "@hobbots/domain";
import { messages } from "./messages.ts";

/** What one used skill's line says after "Used": its title, then its revision or where it came from. */
export const usedLine = (used: UsedSkill): { readonly title: string; readonly detail: string } => ({
  title: skillTitle(used.name),
  detail:
    used.number !== null
      ? messages.revision({ number: used.number })
      : used.source === "organization"
        ? messages.organization
        : "",
});

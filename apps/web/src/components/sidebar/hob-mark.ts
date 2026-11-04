import type { HobState } from "../../lib/hob-state.ts";

/** What the sidebar says about a hob: four words, so a glance tells who needs you and who works. */
export type SidebarState = "needs-you" | "working" | "paused" | "resting";

export const sidebarState = (state: HobState): SidebarState => {
  if (state === "needs-you" || state === "waiting") return "needs-you";
  if (state === "working" || state === "thinking") return "working";
  return state === "paused" || state === "asleep" ? "paused" : "resting";
};

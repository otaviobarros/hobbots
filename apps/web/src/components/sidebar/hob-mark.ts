import type { HobState } from "../../lib/hob-state.ts";

/** What the sidebar says about a hob: four words, so a glance tells who needs you and who works. */
/** `waiting`: it has answered and waits only on a command it started, which carries no mark (#1056). */
export type SidebarState = "needs-you" | "working" | "waiting" | "paused" | "resting";

export const sidebarState = (state: HobState): SidebarState => {
  if (state === "needs-you" || state === "waiting") return "needs-you";
  if (state === "working" || state === "thinking") return "working";
  if (state === "on-command") return "waiting";
  return state === "paused" || state === "asleep" ? "paused" : "resting";
};

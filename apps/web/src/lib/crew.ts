import type { HobState } from "./hob-state.ts";

/** The scene shows at most five hobs: those who need you first, then the busiest. */
export const SCENE_LIMIT = 5;

/** The groups Home counts hobs in for its summary line. */
export type CrewGroup = "needs-you" | "working" | "waiting" | "failed" | "resting" | "paused";

const groupOfState: Record<HobState, CrewGroup> = {
  "needs-you": "needs-you",
  working: "working",
  thinking: "working",
  waiting: "waiting",
  failed: "failed",
  idle: "resting",
  asleep: "resting",
  paused: "paused",
};

export const groupOf = (state: HobState): CrewGroup => groupOfState[state];

/** The five hobs in the scene, and how many wait in the hall behind the door. */
export const splitScene = <T>(ordered: ReadonlyArray<T>): { stage: Array<T>; hall: number } => ({
  stage: ordered.slice(0, SCENE_LIMIT),
  hall: Math.max(0, ordered.length - SCENE_LIMIT),
});

/** Whether a hob matches a filter by name or role title; an empty filter matches every hob. */
export const matchesHob = (hob: { readonly name: string; readonly roleTitle: string }, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q === "" || hob.name.toLowerCase().includes(q) || hob.roleTitle.toLowerCase().includes(q);
};

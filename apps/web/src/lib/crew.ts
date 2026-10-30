import type { HobState } from "./hob-state.ts";

/** The scene shows at most six hobs: those who need you first, then the busiest. */
export const SCENE_LIMIT = 6;

/** Past this many hobs, the Resting group starts folded on Home. */
export const FOLD_RESTING_PAST = 12;

/** The groups Home sorts hobs into, in the order they are listed. */
export type CrewGroup = "needs-you" | "working" | "waiting" | "failed" | "resting" | "paused";

export const groupOrder: ReadonlyArray<CrewGroup> = ["needs-you", "working", "waiting", "failed", "resting", "paused"];

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

/** The six hobs in the scene, and how many wait in the hall behind the door. */
export const splitScene = <T>(ordered: ReadonlyArray<T>): { stage: Array<T>; hall: number } => ({
  stage: ordered.slice(0, SCENE_LIMIT),
  hall: Math.max(0, ordered.length - SCENE_LIMIT),
});

/** Whether a hob matches a filter by name or craft; an empty filter matches every hob. */
export const matchesHob = (hob: { readonly name: string; readonly craft: string }, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q === "" || hob.name.toLowerCase().includes(q) || hob.craft.toLowerCase().includes(q);
};

/** Hobs grouped by state, in list order, leaving out empty groups; members keep their order. */
export const groupCrew = <T extends { readonly state: HobState }>(
  crew: ReadonlyArray<T>,
): Array<{ group: CrewGroup; members: Array<T> }> =>
  groupOrder
    .map((group) => ({ group, members: crew.filter((member) => groupOf(member.state) === group) }))
    .filter(({ members }) => members.length > 0);

/** Whether a group starts folded: only Resting, and only once there are more than 12 hobs. */
export const foldsByDefault = (group: CrewGroup, total: number): boolean =>
  group === "resting" && total > FOLD_RESTING_PAST;

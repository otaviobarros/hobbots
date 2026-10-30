/** Sprite states from the design sprite sheet that the current build can show, plus paused. */
export type HobState = "idle" | "thinking" | "working" | "waiting" | "needs-you" | "asleep" | "paused" | "failed";

/**
 * A hob's lifecycle on the hub (AG-006). Hobs saved before the server reported a status are active.
 * Retired hobs leave Home, so only active and paused reach a scene.
 */
export type HobLifecycle = "active" | "paused" | "retired";

/** Words for a state, for headers and screen readers. */
export const stateLabel: Record<HobState, string> = {
  idle: "ready",
  thinking: "thinking",
  working: "working",
  waiting: "waiting",
  "needs-you": "needs you",
  asleep: "asleep",
  paused: "paused",
  failed: "had a problem",
};

/**
 * The one place a hob's state is worked out: its lifecycle first, then what its threads are doing.
 * A paused hob shows as paused even while a reply it started before the pause finishes streaming.
 */
export const hobState = (
  hob: { readonly id: string; readonly status?: HobLifecycle | undefined },
  threads: ReadonlyArray<{ readonly id: string }> | undefined,
  activity: Readonly<Record<string, "thinking" | "working">>,
): HobState => {
  if (hob.status === "paused") return "paused";
  const states = (threads ?? []).map((t) => activity[t.id]).filter((a) => a !== undefined);
  if (states.includes("working")) return "working";
  return states.length > 0 ? "thinking" : "idle";
};

// Who stands in front of the scene: those who need you, then the busiest, then the rest.
const sceneRank: Record<HobState, number> = {
  "needs-you": 0,
  waiting: 1,
  failed: 2,
  working: 3,
  thinking: 4,
  idle: 5,
  asleep: 6,
  paused: 7,
};

/** Orders hobs for the Home scene; hobs in the same state keep their order. */
export const sceneOrder = <T extends { readonly state: HobState }>(crew: ReadonlyArray<T>): Array<T> =>
  crew
    .map((member, index) => ({ member, index }))
    .sort((a, b) => sceneRank[a.member.state] - sceneRank[b.member.state] || a.index - b.index)
    .map(({ member }) => member);

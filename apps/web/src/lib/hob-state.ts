import type { Agent } from "@hobbots/domain";

/** Sprite states from the design sprite sheet that the current build can show, plus paused. */
export type HobState = "idle" | "thinking" | "working" | "waiting" | "needs-you" | "asleep" | "paused" | "failed";

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
 * The one place a hob's state is worked out: its lifecycle (AG-006) first, then what its threads are
 * doing. Retired hobs leave the hob list, so only active and paused hobs reach it.
 * A paused hob shows as paused even while a reply it started before the pause finishes streaming.
 */
export const hobState = (
  hob: Pick<Agent, "status">,
  threads: ReadonlyArray<{ readonly id: string }> | undefined,
  activity: Readonly<Record<string, "thinking" | "working">>,
): HobState => {
  if (hob.status === "paused") return "paused";
  const states = (threads ?? []).map((t) => activity[t.id]).filter((a) => a !== undefined);
  if (states.includes("working")) return "working";
  return states.length > 0 ? "thinking" : "idle";
};

/**
 * One thread's state for the chat header. The hob's lifecycle wins here too, so the header agrees
 * with the rail and Home while a reply started before the pause finishes.
 */
export const threadState = (
  hob: Pick<Agent, "status">,
  activity: "thinking" | "working" | undefined,
  streaming: boolean,
): HobState => {
  if (hob.status === "paused") return "paused";
  return activity ?? (streaming ? "working" : "idle");
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

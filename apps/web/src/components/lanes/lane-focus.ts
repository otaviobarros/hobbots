import type { FocusTargets } from "../move-on/follow-focus.ts";
import { nextWaiting } from "../move-on/places.ts";

/** Marks a lane, for `laneTargets`. */
export const LANE = { "data-lane": "" } as const;

/** Marks a lane's header button, for `laneTargets`. */
export const LANE_HEAD = { "data-lane-head": "" } as const;

/**
 * Where focus goes after you answer in a lane (#995): the lane's next waiting item, such as another
 * question or a failed Task, or else its header button, which is always there and names the lane.
 */
export const laneTargets: FocusTargets = (from) => {
  const lane = from.closest("[data-lane]");
  return {
    next: () => nextWaiting(lane, from),
    fallback: () => lane?.querySelector<HTMLElement>("[data-lane-head]") ?? null,
  };
};

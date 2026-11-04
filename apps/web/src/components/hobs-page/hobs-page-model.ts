import type { Thread } from "@hobbots/domain";
import type { HobState } from "../../lib/hob-state.ts";

/** The page's filters; All is the default and stays out of the URL. */
const HOB_FILTERS = ["all", "needs", "working", "resting"] as const;
export type HobFilter = (typeof HOB_FILTERS)[number];

export const isHobFilter = (value: unknown): value is HobFilter =>
  typeof value === "string" && (HOB_FILTERS as ReadonlyArray<string>).includes(value);

/** The filter a hob's state falls under: a hob that waits on you or had a problem needs you. */
export const filterOf = (state: HobState): Exclude<HobFilter, "all"> => {
  switch (state) {
    case "needs-you":
    case "waiting":
    case "failed":
      return "needs";
    case "working":
    case "thinking":
      return "working";
    case "idle":
    case "asleep":
    case "paused":
      return "resting";
  }
};

/** How many hobs each filter shows. */
export const filterCounts = (crew: ReadonlyArray<{ readonly state: HobState }>): Record<HobFilter, number> => {
  const counts: Record<HobFilter, number> = { all: crew.length, needs: 0, working: 0, resting: 0 };
  for (const { state } of crew) counts[filterOf(state)] += 1;
  return counts;
};

/** The hobs a filter shows, in their usual order. */
export const shownCrew = <T extends { readonly state: HobState }>(
  crew: ReadonlyArray<T>,
  filter: HobFilter,
): ReadonlyArray<T> => (filter === "all" ? crew : crew.filter((member) => filterOf(member.state) === filter));

/** The hob's most recently active chat, or undefined when it has none. */
export const lastChat = <T extends Pick<Thread, "updatedAt">>(threads: ReadonlyArray<T>): T | undefined =>
  threads.reduce<T | undefined>(
    (newest, thread) => (newest && newest.updatedAt >= thread.updatedAt ? newest : thread),
    undefined,
  );

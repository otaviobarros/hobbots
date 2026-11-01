import type { TaskState } from "@hobbots/domain";
import { formatCount } from "../../lib/format.ts";

/** Copy for a party member's work on another hob's Quest, on Home and in the hob panel (STD-I18N-001). */
export const messages = {
  onQuest: ({ lead }: { lead: string }) => `On ${lead}'s quest`,
  /** The accessible name of a link to the Quest from a member's work. */
  openQuest: ({ name, lead, state }: { name: string; lead: string; state: string }) =>
    `${name} is on ${lead}'s quest, ${state}. Open the Quest`,
  /** Where a member's Task stands, in words. */
  state: {
    queued: "Not started",
    active: "Working",
    waiting: "Waiting",
    blocked: "Blocked",
    cancelling: "Cancelling…",
    completed: "Done",
    failed: "Had a problem",
    cancelled: "Cancelled",
  } satisfies Record<TaskState, string>,
  home: {
    title: "Quests in progress",
    empty: "No quests yet. When hobs share work, each Quest shows here with who is on it and how far it got.",
    progress: ({ done, total }: { done: number; total: number }) =>
      `${formatCount(done)} of ${formatCount(total)} done`,
  },
};

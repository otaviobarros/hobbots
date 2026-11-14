import type { TaskState } from "@hobbots/domain";

/** Copy for a party member's work on another hob's Quest, on Home and on its page (STD-I18N-001). */
export const messages = {
  /** The accessible name of a link to the Quest from a member's work, which the row names by its goal. */
  openQuest: ({ name, lead, goal, state }: { name: string; lead: string; goal: string; state: string }) =>
    `${name} is on ${lead}'s quest “${goal}”, ${state}. Open the quest`,
  /** Where a member's Task stands, in words. */
  state: {
    queued: "Not started",
    active: "Working",
    waiting: "Waiting",
    blocked: "Blocked",
    pausing: "Pausing…",
    paused: "Paused",
    cancelling: "Cancelling…",
    completed: "Done",
    failed: "Had a problem",
    cancelled: "Cancelled",
  } satisfies Record<TaskState, string>,
};

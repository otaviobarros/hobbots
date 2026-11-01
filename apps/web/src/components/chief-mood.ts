import type { ChiefMood } from "./chief-mark.tsx";
import { messages } from "./messages.ts";

const copy = messages.chief;

/**
 * The chief's mood on the rail: needs-you while any request waits in the Inbox, working while any
 * hob works, idle otherwise. `preview` is the mood a development build was asked to show.
 */
export const chiefMood = ({
  waiting,
  working,
  preview,
}: {
  readonly waiting: number;
  readonly working: boolean;
  readonly preview?: ChiefMood | null | undefined;
}): ChiefMood => preview ?? (waiting > 0 ? "needs-you" : working ? "working" : "idle");

/** What the chief's link says: where it leads and, while requests wait, how many. */
export const chiefLabel = (mood: ChiefMood, waiting: number): string => {
  if (mood === "needs-you") return copy.needsYou({ count: Math.max(waiting, 1) });
  return mood === "working" ? copy.working : copy.home;
};

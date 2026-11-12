import { formatAgo, formatCount, formatDuration, plural } from "../../lib/format.ts";
import type { TicketEnd, TicketProgress } from "./ticket-model.ts";

const ENDED: Record<TicketEnd, (took: string) => string> = {
  completed: (took) => `Finished in ${took}`,
  failed: (took) => `Failed after ${took}`,
  cancelled: (took) => `Cancelled after ${took}`,
};

/** Copy for the Quest's ticket under the request in the chat (STD-I18N-001). */
export const messages = {
  /** What a screen reader hears between the ticket's parts, which the eye gets from the layout. */
  said: { title: ": ", part: ", ", open: ". " },
  progress: (progress: TicketProgress, now?: Date): string =>
    progress.kind === "count"
      ? `${formatCount(progress.done)} of ${formatCount(progress.total)} done`
      : progress.kind === "started"
        ? `Started ${formatAgo(progress.at, now)}`
        : ENDED[progress.end](formatDuration(progress.took)),
  needsYou: (count: number) => plural(count, { one: "1 needs you", other: `${formatCount(count)} need you` }),
  /** Work about the request ran out of tries and waits for you in the Inbox (IN-007). */
  stuck: "Stuck",
  openQuest: "Open quest",
  /** The hobs past the sprites the ticket shows; their names are in the quest. */
  more: (count: number) => `+${formatCount(count)}`,
};

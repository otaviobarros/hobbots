import { formatAgo, formatCount, formatDuration, plural } from "../../lib/format.ts";
import type { TicketEnd, TicketProgress } from "./ticket-model.ts";

const ENDED: Record<TicketEnd, (took: string) => string> = {
  completed: (took) => `Finished in ${took}`,
  failed: (took) => `Failed after ${took}`,
  cancelled: (took) => `Cancelled after ${took}`,
};

/** Copy for the Quest's ticket under the request in the chat (STD-I18N-001). */
export const messages = {
  /** The ticket's name for a screen reader: the Quest, and where it stands, in one line. */
  label: ({ title, state }: { title: string; state: string }) => `Open the ${title} room: ${state}`,
  progress: (progress: TicketProgress, now?: Date): string =>
    progress.kind === "count"
      ? `${formatCount(progress.done)} of ${formatCount(progress.total)} done`
      : progress.kind === "started"
        ? `Started ${formatAgo(progress.at, now)}`
        : ENDED[progress.end](formatDuration(progress.took)),
  needsYou: (count: number) => plural(count, { one: "1 needs you", other: `${formatCount(count)} need you` }),
  /** Work about the request ran out of tries and waits for you in the Inbox (IN-007). */
  stuck: "Stuck",
  openRoom: "Open room",
};

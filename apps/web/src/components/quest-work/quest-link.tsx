import type { Quest } from "@hobbots/domain";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Opens a Quest where it lives: the lead's chat for the request that started it, with its card,
 * strip and Quest tab. A Quest without a thread opens the lead.
 */
export function QuestLink({
  quest,
  label,
  className,
  children,
}: {
  quest: Quest;
  /** Names the link when its content alone would not. */
  label?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return quest.threadId === null ? (
    <Link to="/hobs/$hobId" params={{ hobId: quest.leadId }} aria-label={label} className={className}>
      {children}
    </Link>
  ) : (
    <Link
      to="/hobs/$hobId/threads/$threadId"
      params={{ hobId: quest.leadId, threadId: quest.threadId }}
      aria-label={label}
      className={className}
    >
      {children}
    </Link>
  );
}

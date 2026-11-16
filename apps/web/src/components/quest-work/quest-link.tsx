import type { AgentId, Quest, TaskId } from "@hobbots/domain";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { questSearch } from "../quest-sheet/quest-search.ts";

/**
 * Opens a Quest where it is followed: the chat of the request that started it, with its card,
 * header quest button, with the quest open on `taskId` in its sheet. That channel belongs to `channelAgentId`,
 * which for a nested Quest is not its lead. A Quest without a channel opens its lead.
 */
export function QuestLink({
  quest,
  channelAgentId,
  taskId,
  label,
  className,
  children,
}: {
  quest: Quest;
  channelAgentId: AgentId | null;
  /** The Task whose lane the room lights: a member's own Task, or the one the Quest sits on. */
  taskId: TaskId;
  /** Names the link when its content alone would not. */
  label?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return quest.channelId === null || channelAgentId === null ? (
    <Link to="/hobs/$hobId" params={{ hobId: quest.leadId }} aria-label={label} className={className}>
      {children}
    </Link>
  ) : (
    <Link
      to="/hobs/$hobId/channels/$channelId"
      params={{ hobId: channelAgentId, channelId: quest.channelId }}
      search={questSearch(taskId)}
      aria-label={label}
      className={className}
    >
      {children}
    </Link>
  );
}

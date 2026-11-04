import type { AgentId, Quest, TaskId } from "@hobbots/domain";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { roomSearch } from "../quest-room/room-search.ts";

/**
 * Opens a Quest where it is followed: the chat of the request that started it, with its card,
 * header quest button, with its Quest room open on `taskId`'s lane. That thread belongs to `threadAgentId`,
 * which for a nested Quest is not its lead. A Quest without a thread opens its lead.
 */
export function QuestLink({
  quest,
  threadAgentId,
  taskId,
  label,
  className,
  children,
}: {
  quest: Quest;
  threadAgentId: AgentId | null;
  /** The Task whose lane the room lights: a member's own Task, or the one the Quest sits on. */
  taskId: TaskId;
  /** Names the link when its content alone would not. */
  label?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return quest.threadId === null || threadAgentId === null ? (
    <Link to="/hobs/$hobId" params={{ hobId: quest.leadId }} aria-label={label} className={className}>
      {children}
    </Link>
  ) : (
    <Link
      to="/hobs/$hobId/threads/$threadId"
      params={{ hobId: threadAgentId, threadId: quest.threadId }}
      search={roomSearch(taskId)}
      aria-label={label}
      className={className}
    >
      {children}
    </Link>
  );
}

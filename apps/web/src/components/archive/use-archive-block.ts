import type { ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useActivity } from "../../api/activity.ts";
import { approvalsQuery } from "../../api/approvals.ts";
import { messagesQuery } from "../../api/queries.ts";
import { type ArchiveBlock, archiveBlock } from "./archive-rules.ts";

/**
 * Why a thread cannot be archived now, from its messages, its approval requests and live activity.
 * `enabled` false reads only what is already cached, so closed menus fetch nothing.
 */
export const useArchiveBlock = (threadId: ThreadId | undefined, enabled = true): ArchiveBlock | null => {
  const id = threadId ?? ("" as ThreadId);
  const on = enabled && threadId !== undefined;
  const messages = useQuery({ ...messagesQuery(id), enabled: on });
  const approvals = useQuery({ ...approvalsQuery(id), enabled: on });
  const activity = useActivity();
  if (threadId === undefined) return null;
  return archiveBlock({ messages: messages.data, approvals: approvals.data, live: activity[threadId] !== undefined });
};

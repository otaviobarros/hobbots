import type { Agent, AgentId, ApprovalRequest, ThreadId } from "@hobbots/domain";
import { useQueries, useQuery } from "@tanstack/react-query";
import { agentsQuery, archivedAgentsQuery, threadsQuery } from "../../api/queries.ts";
import { messages } from "./messages.ts";

export interface InboxDirectory {
  /** The hob that asked, retired hobs included; undefined while the hobs load. */
  readonly hob: (agentId: AgentId) => Agent | undefined;
  readonly hobName: (agentId: AgentId) => string;
  readonly threadTitle: (threadId: ThreadId) => string;
}

/** Who asked each request and in which thread, read from the hob and thread lists the app already keeps live. */
export const useInboxDirectory = (approvals: ReadonlyArray<ApprovalRequest>): InboxDirectory => {
  const active = useQuery(agentsQuery);
  const retired = useQuery(archivedAgentsQuery);
  const hobs = new Map([...(retired.data ?? []), ...(active.data ?? [])].map((hob) => [hob.id, hob]));
  const askers = Array.from(new Set(approvals.map((approval) => approval.agentId)));
  const threadLists = useQueries({ queries: askers.map((agentId) => threadsQuery(agentId)) });
  const titles = new Map(threadLists.flatMap((list) => (list.data ?? []).map((thread) => [thread.id, thread.title])));
  return {
    hob: (agentId) => hobs.get(agentId),
    hobName: (agentId) => hobs.get(agentId)?.name ?? messages.unknownHob,
    threadTitle: (threadId) => titles.get(threadId) || messages.untitledThread,
  };
};

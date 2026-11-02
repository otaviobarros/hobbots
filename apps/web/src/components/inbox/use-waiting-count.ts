import type { AgentId, ApprovalRequest } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { inboxQuery } from "../../api/approvals.ts";
import { useBlockers } from "../../api/blockers.ts";
import { pendingCount } from "./inbox-items.ts";

/**
 * How many things wait for the user, kept live by the journal: pending requests and stuck work
 * (IN-007). 0 until the Inbox is read.
 */
export const useWaitingCount = (): number =>
  (useQuery({ ...inboxQuery, select: pendingCount }).data ?? 0) + useBlockers().length;

/** The hobs with a request, or stuck work, waiting for the user. */
export const useWaitingHobs = (): ReadonlySet<AgentId> => {
  const asking = useQuery({ ...inboxQuery, select: waitingHobs }).data ?? NONE;
  const stuck = useBlockers();
  return stuck.length === 0 ? asking : new Set([...asking, ...stuck.map((item) => item.recipientId)]);
};

const NONE: ReadonlySet<AgentId> = new Set();

const waitingHobs = (approvals: ReadonlyArray<ApprovalRequest>): ReadonlySet<AgentId> =>
  new Set(approvals.flatMap((approval) => (approval.state === "pending" ? [approval.agentId] : [])));

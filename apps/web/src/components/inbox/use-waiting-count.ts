import type { AgentId, ApprovalRequest } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { inboxQuery } from "../../api/approvals.ts";
import { pendingCount } from "./inbox-items.ts";

/** How many requests wait for the user, kept live by the journal; 0 until the Inbox is read. */
export const useWaitingCount = (): number => useQuery({ ...inboxQuery, select: pendingCount }).data ?? 0;

/** The hobs with a request waiting for the user. */
export const useWaitingHobs = (): ReadonlySet<AgentId> => useQuery({ ...inboxQuery, select: waitingHobs }).data ?? NONE;

const NONE: ReadonlySet<AgentId> = new Set();

const waitingHobs = (approvals: ReadonlyArray<ApprovalRequest>): ReadonlySet<AgentId> =>
  new Set(approvals.flatMap((approval) => (approval.state === "pending" ? [approval.agentId] : [])));

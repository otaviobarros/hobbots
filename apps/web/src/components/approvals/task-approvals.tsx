import type { ApprovalRequest } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { agentsQuery } from "../../api/queries.ts";
import { ApprovalCard } from "./approval-card.tsx";

/**
 * The requests of `approvals` that a member's turn made, which the Quest shows (#698): each one
 * pending, and each one shown here while pending, so a decision made here or elsewhere shows its
 * outcome in place instead of the card vanishing. A chat turn's requests show in its reply instead.
 */
export const useShownApprovals = (approvals: ReadonlyArray<ApprovalRequest>): ReadonlyArray<ApprovalRequest> => {
  const shown = useRef(new Set<string>());
  const kept = approvals.filter(
    (approval) => approval.messageId === null && (approval.state === "pending" || shown.current.has(approval.id)),
  );
  for (const approval of kept) shown.current.add(approval.id);
  return kept;
};

/**
 * Requests where their Task shows, each as its card: Allow or Deny here decides the same request the
 * Inbox shows. A request from a hob this client does not know yet shows once it does.
 */
export function TaskApprovals({ approvals }: { approvals: ReadonlyArray<ApprovalRequest> }) {
  const hobs = useQuery(agentsQuery).data ?? [];
  return approvals.map((approval) => {
    const hob = hobs.find((each) => each.id === approval.agentId);
    return hob === undefined ? null : <ApprovalCard key={approval.id} approval={approval} hob={hob} via="chat" />;
  });
}

import type { ApprovalRequest } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { approvalQuery } from "../../api/approvals.ts";
import { byCreation } from "../../api/inbox-window.ts";

/**
 * The Inbox's requests with `shown`, the request the address names, among them: History keeps
 * only the latest closed requests, so the one open beside the list can drop out of it when
 * another is decided.
 */
export const withShown = (
  approvals: ReadonlyArray<ApprovalRequest>,
  shown: ApprovalRequest | undefined,
  requestId: string | undefined,
): ReadonlyArray<ApprovalRequest> => {
  if (shown === undefined || shown.id !== requestId) return approvals;
  if (approvals.some((approval) => approval.id === shown.id)) return approvals;
  return [...approvals, shown].sort(byCreation);
};

/**
 * The Inbox's requests with the one the address names, read on its own from the hub while the
 * list does not hold it, so it stays in view, as it is now, when History moves on. `resolving`
 * is true while that read is under way, when no other request should take its place.
 */
export const useWithShown = (
  approvals: ReadonlyArray<ApprovalRequest>,
  requestId: string | undefined,
  ready: boolean,
): { readonly approvals: ReadonlyArray<ApprovalRequest>; readonly resolving: boolean } => {
  const missing = ready && requestId !== undefined && !approvals.some((approval) => approval.id === requestId);
  const shown = useQuery({ ...approvalQuery(requestId ?? ""), enabled: missing });
  return { approvals: withShown(approvals, shown.data, requestId), resolving: missing && shown.isPending };
};

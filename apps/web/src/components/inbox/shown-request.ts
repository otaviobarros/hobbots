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

/** Why the request the address names is not shown yet: its own read is under way, or failed. */
export type ShownHold = "loading" | "failed";

/**
 * Whether the request the address names holds its place while its own read has no answer to show:
 * no other request may take its place then, so the address keeps naming it, through a failed read
 * too, until the user picks another one or reads it again.
 */
export const shownHold = (missing: boolean, status: "pending" | "error" | "success"): ShownHold | undefined => {
  if (!missing || status === "success") return undefined;
  return status === "pending" ? "loading" : "failed";
};

/**
 * The Inbox's requests with the one the address names, read on its own from the hub while the
 * list does not hold it, so it stays in view, as it is now, when History moves on. `hold` says
 * why it is not shown yet (see `shownHold`), and `retry` reads it again.
 */
export const useWithShown = (
  approvals: ReadonlyArray<ApprovalRequest>,
  requestId: string | undefined,
  ready: boolean,
): {
  readonly approvals: ReadonlyArray<ApprovalRequest>;
  readonly hold: ShownHold | undefined;
  readonly retry: () => void;
} => {
  const missing = ready && requestId !== undefined && !approvals.some((approval) => approval.id === requestId);
  const shown = useQuery({ ...approvalQuery(requestId ?? ""), enabled: missing });
  return {
    approvals: withShown(approvals, shown.data, requestId),
    hold: shownHold(missing, shown.status),
    retry: () => void shown.refetch(),
  };
};

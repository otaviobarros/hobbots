import type { ApprovalRequest } from "@hobbots/domain";
import { useState } from "react";
import { byCreation } from "../../api/inbox-window.ts";

/**
 * The Inbox's requests with the one the address names kept among them: History keeps only the
 * latest closed requests, so the one open beside the list can drop out of it when another is
 * decided. A closed request never changes again, so its last version stays right.
 */
export const withShown = (
  approvals: ReadonlyArray<ApprovalRequest>,
  kept: ApprovalRequest | undefined,
  requestId: string | undefined,
): ReadonlyArray<ApprovalRequest> => {
  if (kept === undefined || kept.id !== requestId) return approvals;
  if (approvals.some((approval) => approval.id === kept.id)) return approvals;
  return [...approvals, kept].sort(byCreation);
};

/** The Inbox's requests, keeping the last seen version of the request the address names (see `withShown`). */
export const useWithShown = (
  approvals: ReadonlyArray<ApprovalRequest>,
  requestId: string | undefined,
): ReadonlyArray<ApprovalRequest> => {
  const found = approvals.find((approval) => approval.id === requestId);
  const [kept, setKept] = useState(found);
  // Remembered while rendering, as React suggests for state that follows props.
  if (found !== undefined && found !== kept) setKept(found);
  return withShown(approvals, found ?? kept, requestId);
};

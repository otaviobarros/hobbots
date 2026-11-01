import { type ApprovalRequest, INBOX_HISTORY } from "@hobbots/domain";

/** Compares text by code unit, as the hub's queries order it (`COLLATE "C"` on PostgreSQL). */
const bytewise = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The most recently decided or expired first, as the hub picks the Inbox's closed requests. */
export const byClosing = (a: ApprovalRequest, b: ApprovalRequest): number =>
  bytewise(b.decidedAt ?? b.createdAt, a.decidedAt ?? a.createdAt) || bytewise(b.id, a.id);

/** Oldest first, as the hub lists them. */
export const byCreation = (a: ApprovalRequest, b: ApprovalRequest): number =>
  bytewise(a.createdAt, b.createdAt) || bytewise(a.id, b.id);

/**
 * The Inbox's requests as the hub would list them now: every pending one and the
 * `INBOX_HISTORY` most recently closed, oldest first. Applied after live updates and refetches
 * too, so decisions arriving from the journal never grow History past its window.
 */
export const inboxWindow = (approvals: ReadonlyArray<ApprovalRequest>): Array<ApprovalRequest> => {
  const kept = new Set(
    approvals
      .filter((approval) => approval.state !== "pending")
      .sort(byClosing)
      .slice(0, INBOX_HISTORY)
      .map((approval) => approval.id),
  );
  return approvals.filter((approval) => approval.state === "pending" || kept.has(approval.id)).sort(byCreation);
};

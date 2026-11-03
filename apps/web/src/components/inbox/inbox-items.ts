import { type ApprovalRequest, type DeviceId, exactAction, type ThreadId } from "@hobbots/domain";
import { byClosing } from "../../api/inbox-window.ts";
import { operationLabel } from "../../lib/reply-steps.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** The Inbox's tabs: what needs you now, everything, and what was decided or expired. */
export const INBOX_TABS = ["needs", "all", "history"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const isInboxTab = (value: unknown): value is InboxTab =>
  typeof value === "string" && (INBOX_TABS as ReadonlyArray<string>).includes(value);

/** How many requests wait for the user's decision. */
export const pendingCount = (approvals: ReadonlyArray<ApprovalRequest>): number =>
  approvals.filter((approval) => approval.state === "pending").length;

/**
 * The tab's requests. Needs you lists the pending ones oldest first, so the one asked first, which
 * expires first, leads; All lists the newest first and History the most recently decided first. `kept` names a request that stays
 * listed in Needs you after it is decided, so the one the user is looking at does not vanish.
 */
export const tabRequests = (
  approvals: ReadonlyArray<ApprovalRequest>,
  tab: InboxTab,
  kept?: string | undefined,
): Array<ApprovalRequest> => {
  if (tab === "needs") return approvals.filter((approval) => approval.state === "pending" || approval.id === kept);
  if (tab === "all") return [...approvals].reverse();
  return approvals.filter((approval) => approval.state !== "pending").sort(byClosing);
};

export interface InboxGroup {
  readonly threadId: ThreadId;
  readonly requests: ReadonlyArray<ApprovalRequest>;
}

/**
 * Requests grouped by their hob's thread until Quests exist (ADR 015), each group where its first
 * request falls, so the groups keep the tab's order.
 */
export const groupByThread = (requests: ReadonlyArray<ApprovalRequest>): Array<InboxGroup> => {
  const groups = new Map<ThreadId, Array<ApprovalRequest>>();
  for (const request of requests) {
    const group = groups.get(request.threadId);
    if (group === undefined) groups.set(request.threadId, [request]);
    else group.push(request);
  }
  return Array.from(groups, ([threadId, grouped]) => ({ threadId, requests: grouped }));
};

/** When a pending request expires, in words: "expires in 3 h". Empty when it names no expiry. */
export const expiryText = (expiresAt: string | null, now: Date = new Date()): string => {
  if (expiresAt === null) return "";
  const minutes = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return copy.expiry.soon;
  if (minutes < 60) return copy.expiry.minutes({ count: minutes });
  return copy.expiry.hours({ count: Math.floor(minutes / 60) });
};

/** The short line under a request in the list: whether it waits, and for how long, or how it ended. */
export const statusText = (approval: ApprovalRequest, now: Date = new Date()): string => {
  switch (approval.state) {
    case "pending": {
      const expiry = expiryText(approval.expiresAt, now);
      return expiry === "" ? copy.status.pendingNoExpiry : copy.status.pending({ expiry });
    }
    case "approved":
      if (approval.lifetime === "always") return copy.status.approvedAlways;
      return approval.lifetime === "task" ? copy.status.approvedForTask : copy.status.approved;
    case "denied":
      return copy.status.denied;
    default:
      return copy.status.expired;
  }
};

/** The verdict tag a closed request shows in History. */
export const verdictText = (approval: ApprovalRequest): string => {
  if (approval.state === "denied") return copy.history.verdict.denied;
  if (approval.state === "expired") return copy.history.verdict.expired;
  return copy.history.verdict[approval.lifetime ?? "once"];
};

/**
 * Who decided a closed request, from which device and where, as History shows it (#598): "Allowed
 * once from Mac in the Inbox". An expired one says nobody decided. Null for a pending request and
 * for one closed before deciders were recorded.
 */
export const deciderText = (approval: ApprovalRequest, deviceName: (deviceId: DeviceId) => string): string | null => {
  if (approval.decidedVia === "expired") return copy.history.expiredUndecided;
  if (approval.decidedByDeviceId === null) return null;
  if (approval.state !== "approved" && approval.state !== "denied") return null;
  const decision =
    approval.state === "denied" ? copy.history.decided.denied : copy.history.decided[approval.lifetime ?? "once"];
  return copy.history.decider({
    decision,
    device: deviceName(approval.decidedByDeviceId),
    surface: approval.decidedVia === null ? null : copy.history.surface[approval.decidedVia],
  });
};

/**
 * The request to show beside the list: the one named in the address when the tab lists it,
 * otherwise the tab's first.
 */
export const selectedRequest = (
  requests: ReadonlyArray<ApprovalRequest>,
  id: string | undefined,
): ApprovalRequest | undefined => requests.find((request) => request.id === id) ?? requests[0];

/** What a request asks to do, in the Permissions tab's words, and the exact command, address or file. */
export const requestTitle = (approval: ApprovalRequest): { readonly what: string; readonly exact: string } => ({
  what: operationLabel(approval.operation),
  exact: exactAction(approval),
});

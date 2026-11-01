import type { ApprovalRequest } from "@hobbots/domain";
import { requestTitle } from "./inbox-items.ts";
import { messages } from "./messages.ts";

const copy = messages.notice;

/** macOS cuts a notification at 256 bytes, so the exact action is kept well under that. */
const EXACT_LIMIT = 120;

/**
 * The pending requests that arrived since `seen`, and the requests seen from now on. The first
 * read of the Inbox only learns what already waits, so opening the app announces nothing.
 */
export const freshRequests = (
  seen: ReadonlySet<string> | undefined,
  approvals: ReadonlyArray<ApprovalRequest>,
): { readonly fresh: ReadonlyArray<ApprovalRequest>; readonly seen: ReadonlySet<string> } => {
  const pending = approvals.filter((approval) => approval.state === "pending");
  return {
    fresh: seen === undefined ? [] : pending.filter((approval) => !seen.has(approval.id)),
    seen: new Set([...(seen ?? []), ...pending.map((approval) => approval.id)]),
  };
};

/** The system notification for a request: who asks, and the action in the Inbox's words. */
export const requestNotice = (
  approval: ApprovalRequest,
  name: string,
): { readonly title: string; readonly body: string } => {
  const { what, exact } = requestTitle(approval);
  const short = exact.length > EXACT_LIMIT ? `${exact.slice(0, EXACT_LIMIT - 1)}…` : exact;
  return { title: copy.title({ name }), body: copy.body({ what, exact: short }) };
};

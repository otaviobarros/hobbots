import type { ApprovalRequest, HobbotsEvent } from "@hobbots/domain";
import { requestTitle } from "./inbox-items.ts";
import { messages } from "./messages.ts";

const copy = messages.notice;

/** macOS cuts a notification at 256 bytes, so the exact action is kept well under that. */
const EXACT_LIMIT = 120;

/**
 * What an event means for the request notifications: `show` a request that now waits for the
 * user, or `close` the one for a request that no longer does. `current` is the request as the
 * Inbox holds it after the event, when it is loaded, so a request replayed after it was decided is
 * never announced.
 */
export const noticeChange = (
  event: HobbotsEvent,
  current: ApprovalRequest | undefined,
): { readonly show: ApprovalRequest } | { readonly close: string } | undefined => {
  if (event._tag === "ApprovalRequested") {
    const approval = current ?? event.approval;
    return approval.state === "pending" ? { show: approval } : { close: approval.id };
  }
  if (event._tag === "ApprovalResolved") return { close: event.approval.id };
  return undefined;
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

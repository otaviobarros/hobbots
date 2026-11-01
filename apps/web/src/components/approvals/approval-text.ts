import type { ApprovalRequest } from "@hobbots/domain";
import { ApiError } from "../../api/client.ts";
import { formatTime } from "../../lib/time.ts";
import { messages } from "../messages.ts";

const copy = messages.approval;

/** The arguments that say exactly what a call does, in the order they are looked for. */
const EXACT_KEYS = ["command", "url", "file_path", "notebook_path", "path", "pattern", "query"] as const;

/**
 * The exact action to show: the command, address, file or pattern the call was made with, or the
 * step's words when the call has none of these.
 */
export const exactAction = (approval: ApprovalRequest): string => {
  for (const key of EXACT_KEYS) {
    const value = approval.arguments[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return approval.label;
};

/** The line a decided or expired request leaves in the card. */
export const resultText = (approval: ApprovalRequest, name: string): string => {
  switch (approval.state) {
    case "approved":
      return approval.lifetime === "always" ? copy.approvedAlways({ name }) : copy.approved({ name });
    case "denied":
      return approval.denyReason === null
        ? copy.denied({ name })
        : copy.deniedWithReason({ name, reason: approval.denyReason });
    default:
      return copy.expired;
  }
};

/** Whole calendar days from one local date to another. */
const calendarDays = (from: Date, to: Date) => {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day(to) - day(from)) / 86_400_000);
};

/**
 * When a pending request expires: at most a day after it was asked (ADR 015), or sooner when its
 * reply stops. Requests from before expiries were stored only expire with their reply.
 */
export const expiryText = (approval: ApprovalRequest, now: Date = new Date()): string => {
  if (approval.expiresAt === null) return copy.expires;
  const at = new Date(approval.expiresAt);
  if (at.getTime() <= now.getTime()) return copy.expiresNow;
  const time = formatTime(approval.expiresAt);
  return calendarDays(now, at) === 0 ? copy.expiresToday({ time }) : copy.expiresTomorrow({ time });
};

/** Why a decision did not go through, in words for the person. */
export const decisionErrorText = (error: unknown): string => {
  const tag = error instanceof ApiError ? error.tag : undefined;
  if (tag === "ApprovalClosed") return copy.closed;
  if (tag === "ApprovalActionChanged") return copy.changed;
  if (tag === "ApprovalNotConfirmed") return copy.notConfirmed;
  if (tag === "ApprovalNotGrantable" || tag === "GrantRuleRefused") return copy.ruleRefused;
  return copy.failed;
};

import type { ApprovalRequest } from "@hobbots/domain";
import { ApiError } from "../../api/client.ts";
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
      return copy.approved({ name });
    case "denied":
      return approval.denyReason === null
        ? copy.denied({ name })
        : copy.deniedWithReason({ name, reason: approval.denyReason });
    default:
      return copy.expired;
  }
};

/** Why a decision did not go through, in words for the person. */
export const decisionErrorText = (error: unknown): string => {
  const tag = error instanceof ApiError ? error.tag : undefined;
  if (tag === "ApprovalClosed") return copy.closed;
  if (tag === "ApprovalActionChanged") return copy.changed;
  return copy.failed;
};

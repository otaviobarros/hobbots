import { ApprovalDecision, ApprovalId, ApprovalRequest, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  ApprovalActionChanged,
  ApprovalClosed,
  ApprovalNotConfirmed,
  ApprovalNotFound,
  ThreadNotFound,
} from "./errors.ts";

/**
 * The user's decision on a pending approval request (PE-003): approve this one action once, or deny
 * it with an optional reason that goes back to the hob. `actionDigest` is the request's, as shown to
 * the user, so a decision never applies to another action. Approving a high-risk (`onceOnly`)
 * request needs `confirmed` (PE-007).
 */
export const DecideApprovalPayload = Schema.Struct({
  decision: ApprovalDecision,
  actionDigest: Schema.NonEmptyString,
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  confirmed: Schema.optionalKey(Schema.Boolean),
});
export type DecideApprovalPayload = typeof DecideApprovalPayload.Type;

export class ApprovalsGroup extends HttpApiGroup.make("approvals")
  .add(
    // The thread's approval requests, oldest first, whatever their state.
    HttpApiEndpoint.get("forThread", "/threads/:threadId/approvals", {
      params: { threadId: ThreadId },
      success: Schema.Array(ApprovalRequest),
      error: ThreadNotFound,
    }),
    // Deciding a request again the same way returns it unchanged.
    HttpApiEndpoint.post("decide", "/approvals/:approvalId/decision", {
      params: { approvalId: ApprovalId },
      payload: DecideApprovalPayload,
      success: ApprovalRequest,
      error: [ApprovalNotFound, ApprovalClosed, ApprovalActionChanged, ApprovalNotConfirmed],
    }),
  )
  .prefix("/api") {}

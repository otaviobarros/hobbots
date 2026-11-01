import {
  AgentId,
  ApprovalDecision,
  ApprovalId,
  ApprovalLifetime,
  ApprovalRequest,
  Grant,
  GrantId,
  GrantRule,
  ThreadId,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  ApprovalActionChanged,
  ApprovalClosed,
  ApprovalNotConfirmed,
  ApprovalNotFound,
  ApprovalNotGrantable,
  GrantNotFound,
  GrantRuleRefused,
  ThreadNotFound,
} from "./errors.ts";

/**
 * The user's decision on a pending approval request (PE-003, PE-007): approve it with a lifetime, or
 * deny it with an optional reason that goes back to the hob. `actionDigest` is the request's, as
 * shown to the user, so a decision never applies to another action. Approving a high-risk
 * (`onceOnly`) request needs `confirmed`.
 *
 * `lifetime` is `once` when absent. This Quest and Always save the request's `rules`, or the
 * narrower `rules` given here, as grants (ADR 015); a rule broader than the request's own is refused.
 */
export const DecideApprovalPayload = Schema.Struct({
  decision: ApprovalDecision,
  actionDigest: Schema.NonEmptyString,
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  confirmed: Schema.optionalKey(Schema.Boolean),
  lifetime: Schema.optionalKey(ApprovalLifetime),
  rules: Schema.optionalKey(Schema.Array(GrantRule).check(Schema.isMinLength(1), Schema.isMaxLength(64))),
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
      error: [
        ApprovalNotFound,
        ApprovalClosed,
        ApprovalActionChanged,
        ApprovalNotConfirmed,
        ApprovalNotGrantable,
        GrantRuleRefused,
      ],
    }),
  )
  .prefix("/api") {}

/** Standing grants (ADR 015): what each hob may do without asking again, and removing it. */
export class GrantsGroup extends HttpApiGroup.make("grants")
  .add(
    // Grants oldest first, optionally for one hob: the live ones, or with `include=all` revoked and expired ones too.
    HttpApiEndpoint.get("list", "/grants", {
      query: { agentId: Schema.optionalKey(AgentId), include: Schema.optionalKey(Schema.Literals(["live", "all"])) },
      success: Schema.Array(Grant),
    }),
    // Revoking a grant that is already revoked returns it unchanged. The next matching call asks again.
    HttpApiEndpoint.post("revoke", "/grants/:grantId/revoke", {
      params: { grantId: GrantId },
      success: Grant,
      error: GrantNotFound,
    }),
  )
  .prefix("/api") {}

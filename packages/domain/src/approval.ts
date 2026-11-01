import { Effect, Schema } from "effect";
import { ApprovalLifetime, GrantRule } from "./grant-rule.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { PolicyOperation } from "./policy.ts";
import { Revision } from "./revision.ts";

export const ApprovalId = Schema.String.pipe(Schema.brand("ApprovalId"));
export type ApprovalId = typeof ApprovalId.Type;

/**
 * - `pending`: the turn is paused on it until the user decides.
 * - `approved`: the user approved this action, once or with a lifetime that saved a grant.
 * - `denied`: the user said no; `denyReason` goes back to the hob when they gave one.
 * - `expired`: it can no longer be decided: its reply stopped, its hob retired, the call was
 *   aborted, the server restarted or nobody decided within a day. An approved action that the policy no longer allows when it
 *   is about to run stays `approved` and is refused; the tool step says so.
 */
export const ApprovalState = Schema.Literals(["pending", "approved", "denied", "expired"]);
export type ApprovalState = typeof ApprovalState.Type;

/**
 * A tool call the policy answered Ask for, waiting for the user's decision (PE-003). It names the
 * requesting hob, the exact action and the policy it was asked under, so a decision applies to this
 * action only, and a changed action or policy asks again (PE-008).
 */
export class ApprovalRequest extends Schema.Class<ApprovalRequest>("ApprovalRequest")({
  id: ApprovalId,
  agentId: AgentId,
  threadId: ThreadId,
  /** The reply whose turn is paused. */
  messageId: MessageId,
  /** The reply step of the tool call, the runtime's own id for it. */
  stepId: Schema.String,
  /** The runtime's name for the tool, such as `Bash`. */
  tool: Schema.String,
  operation: PolicyOperation,
  /** The canonical paths, the command's folder, or the remote and branch the call was decided on. */
  targets: Schema.Array(Schema.String),
  /** The call's concrete arguments, as the runtime gave them. */
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  /** Short words for the step, such as "Running git push". */
  label: Schema.String,
  /** Why the policy asks, in words for the person. */
  reason: Schema.String,
  /** Identifies the exact action: tool, operation, targets and arguments. */
  actionDigest: Schema.String,
  /** Identifies the rules and policy inputs the call was decided under. */
  policyVersion: Schema.String,
  /**
   * A high-risk action, such as a force push or a push to the default branch: it is approved once
   * only, and only with the user's confirmation (PE-007).
   */
  onceOnly: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
  /**
   * Whether This Quest and Always are offered (ADR 015): only when a saved rule could answer the Ask.
   * False for a high-risk action, a command Hobbots cannot read fully, and an Ask from an override,
   * a restriction or a safety check.
   */
  grantable: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
  /** The rules Always would save, as the card shows them: one per folder, subcommand or host that asked. */
  rules: Schema.Array(GrantRule).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  state: ApprovalState,
  /** The lifetime it was approved with; null until approved, and for requests from before lifetimes. */
  lifetime: Schema.NullOr(ApprovalLifetime).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Why the user denied it, if they said. */
  denyReason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** When a pending request expires if nobody decides it: at most a day after it was asked (ADR 015). */
  expiresAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** When it left `pending`. */
  decidedAt: Schema.NullOr(Schema.String),
  revision: Revision,
}) {}

/** How many decided and expired requests the Inbox lists beside the pending ones: the most recently closed. */
export const INBOX_HISTORY = 200;

/** What the user decides on a pending request: Approve with a lifetime, or Deny with an optional reason. */
export const ApprovalDecision = Schema.Literals(["approve", "deny"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

const DECIDED: Record<ApprovalDecision, ApprovalState> = { approve: "approved", deny: "denied" };

/** The state a decision leads to. */
export const decidedState = (decision: ApprovalDecision): ApprovalState => DECIDED[decision];

/**
 * The same JSON for the same value whatever its keys' order, so a digest of it identifies the value.
 * Meant for JSON values: plain objects, arrays, strings, numbers, booleans and null.
 */
export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

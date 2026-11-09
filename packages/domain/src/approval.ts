import { Effect, Schema } from "effect";
import { DeviceId } from "./device.ts";
import { ApprovalLifetime, GrantRule } from "./grant-rule.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { StoredOperation } from "./policy.ts";
import { Revision } from "./revision.ts";
import { TaskId } from "./task.ts";

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

/** Where the user decided a request: its card in the chat, or the Inbox. */
export const ApprovalSurface = Schema.Literals(["chat", "inbox"]);
export type ApprovalSurface = typeof ApprovalSurface.Type;

/** What closed a request: the user on one of the surfaces, or its expiry, which has no decider. */
export const ApprovalDecidedVia = Schema.Union([ApprovalSurface, Schema.Literal("expired")]);
export type ApprovalDecidedVia = typeof ApprovalDecidedVia.Type;

/**
 * A tool call the policy answered Ask for, waiting for the user's decision (PE-003). It names the
 * requesting hob, the exact action and the policy it was asked under, so a decision applies to this
 * action only, and a changed action or policy asks again (PE-008).
 */
export class ApprovalRequest extends Schema.Class<ApprovalRequest>("ApprovalRequest")({
  id: ApprovalId,
  agentId: AgentId,
  threadId: ThreadId,
  /** The reply whose turn is paused, or null for a party member's turn, which runs outside the chat (ADR 018). */
  messageId: Schema.NullOr(MessageId),
  /**
   * The Task whose turn is paused: a party member's, or the Task a chat turn works on (#670). Null
   * for a chat turn on no Task, and for requests from before these were recorded. A turn outside
   * the chat is the one with no reply.
   */
  taskId: Schema.NullOr(TaskId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * The top Task of the work the call was made in: the Task the chat turn works on, or the top of a
   * step's or a party member's tree. This Task binds a grant to it (ADR 018). Null outside a Task,
   * and for requests from before This Task, which then offer no This Task.
   */
  rootTaskId: Schema.NullOr(TaskId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The reply step of the tool call, the runtime's own id for it. */
  stepId: Schema.String,
  /** The runtime's name for the tool, such as `Bash`. */
  tool: Schema.String,
  operation: StoredOperation,
  /** The canonical paths, the command's folder, or the remote and branch the call was decided on. */
  targets: Schema.Array(Schema.String),
  /** The call's concrete arguments, as the runtime gave them. */
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  /** Short words for the step, such as "Running git push". */
  label: Schema.String,
  /** Why the policy asks, in words for the person. */
  reason: Schema.String,
  /**
   * The policy's code for why it asks, such as `private-address` or `read-the-web` (ADR 036), which
   * picks the card's words. Null for requests from before codes were recorded.
   */
  reasonCode: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
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
   * Whether This Task and Always are offered (ADR 015): only when a saved rule could answer the Ask.
   * This Task also needs the request to come from a Task (`rootTaskId`).
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
  /**
   * The approved device the user decided it from; null while pending, once expired, and for
   * requests decided before deciders were recorded.
   */
  decidedByDeviceId: Schema.NullOr(DeviceId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * Where it was decided, or `expired` when nobody did; null while pending, when the client did not
   * say, and for requests closed before this was recorded.
   */
  decidedVia: Schema.NullOr(ApprovalDecidedVia).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  revision: Revision,
}) {}

/**
 * Whether a request offers This Task (ADR 018): it offers a rule, as Always does, and comes from a
 * Task, which the grant binds to. The card says This Quest once a party joins that Task.
 */
export const offersThisTask = (approval: Pick<ApprovalRequest, "grantable" | "onceOnly" | "rules" | "rootTaskId">) =>
  approval.grantable && !approval.onceOnly && approval.rules.length > 0 && approval.rootTaskId !== null;

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

/**
 * The arguments that say exactly what a call does, in the order they are looked for. A hub tool's
 * call, such as a GitHub push, says it in `summary`, which the hub writes from what it fixed.
 */
const EXACT_KEYS = ["command", "url", "file_path", "notebook_path", "path", "pattern", "query", "summary"] as const;

/**
 * The exact action to show for a request: the command, address, file or pattern the call was made
 * with, or the step's words when the call has none of these. The approval card, the Inbox and the
 * desktop app's notifications all show this.
 */
export const exactAction = (approval: {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly label: string;
}): string => {
  for (const key of EXACT_KEYS) {
    const value = approval.arguments[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return approval.label;
};

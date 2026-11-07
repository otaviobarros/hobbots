import { Effect, Schema } from "effect";
import { ApprovalId } from "./approval.ts";
import { GrantLifetime, GrantRule } from "./grant-rule.ts";
import { AgentId } from "./ids.ts";
import { StoredOperation } from "./policy.ts";
import { Revision } from "./revision.ts";
import { TaskId } from "./task.ts";

/**
 * Standing grants of ADR 015: an approval kept beyond one call, as a rule the user saw. A grant
 * belongs to one hob and names one operation and one site. It answers only the preset's Ask for
 * that site, never a Never, a Deny, a high-risk action, a safety Ask or a narrower Ask (PE-007).
 */

export const GrantId = Schema.String.pipe(Schema.brand("GrantId"));
export type GrantId = typeof GrantId.Type;

/**
 * Why a grant stopped applying (ADR 015): the user removed it, a folder it relied on left the hob's
 * folders, its operation was narrowed to Ask or Never, its hob retired, or the top Task it was bound
 * to ended, or its hob's GitHub identity changed.
 */
export const GrantRevokeReason = Schema.Literals([
  "removed",
  "folder-removed",
  "narrowed",
  "retired",
  "task-ended",
  // The hob's GitHub identity changed, to its own app or back to the user's account (ADR 022).
  "github-identity",
]);
export type GrantRevokeReason = typeof GrantRevokeReason.Type;

/** Who made or ended a grant: the user, or the hub on a change that took the authority away. */
export const GrantActor = Schema.Literals(["user", "hub"]);
export type GrantActor = typeof GrantActor.Type;

export class Grant extends Schema.Class<Grant>("Grant")({
  id: GrantId,
  agentId: AgentId,
  operation: StoredOperation,
  rule: GrantRule,
  lifetime: GrantLifetime,
  /**
   * The top Task a `task` grant is bound to (ADR 018): it applies only to work in that Task's tree,
   * whether or not a party joined it, and ends with it. Null for `always`. Grants journaled before
   * it existed carried an unused `questId` instead, and read as `always` grants with no Task.
   */
  taskId: Schema.NullOr(TaskId).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The approval request it was saved from. */
  approvalId: Schema.NullOr(ApprovalId),
  grantedBy: GrantActor,
  createdAt: Schema.String,
  /** When it stops applying by itself; null when it lasts until removed. */
  expiresAt: Schema.NullOr(Schema.String),
  /** When it last answered a call, so stale rules are easy to spot. */
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  revokedBy: Schema.NullOr(GrantActor),
  revokeReason: Schema.NullOr(GrantRevokeReason),
  revision: Revision,
}) {}

/** Whether a grant still applies at `now` (ISO 8601): not revoked and not past its expiry. */
export const isLiveGrant = (grant: Grant, now: string): boolean =>
  grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now);

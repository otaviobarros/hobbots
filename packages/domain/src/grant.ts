import { Schema } from "effect";
import { ApprovalId } from "./approval.ts";
import { GrantLifetime, GrantRule } from "./grant-rule.ts";
import { AgentId } from "./ids.ts";
import { PolicyOperation } from "./policy.ts";
import { Revision } from "./revision.ts";

/**
 * Standing grants of ADR 015: an approval kept beyond one call, as a rule the user saw. A grant
 * belongs to one hob and names one operation and one site. It answers only the preset's Ask for
 * that site, never a Never, a Deny, a high-risk action, a safety Ask or a narrower Ask (PE-007).
 */

export const GrantId = Schema.String.pipe(Schema.brand("GrantId"));
export type GrantId = typeof GrantId.Type;

/**
 * Why a grant stopped applying (ADR 015): the user removed it, a folder it relied on left the hob's
 * folders, its operation was narrowed to Ask or Never, its hob retired, or its Quest ended.
 */
export const GrantRevokeReason = Schema.Literals(["removed", "folder-removed", "narrowed", "retired", "quest-ended"]);
export type GrantRevokeReason = typeof GrantRevokeReason.Type;

/** Who made or ended a grant: the user, or the hub on a change that took the authority away. */
export const GrantActor = Schema.Literals(["user", "hub"]);
export type GrantActor = typeof GrantActor.Type;

export class Grant extends Schema.Class<Grant>("Grant")({
  id: GrantId,
  agentId: AgentId,
  operation: PolicyOperation,
  rule: GrantRule,
  lifetime: GrantLifetime,
  /** The Quest a `quest` grant is bound to; null for `always`. */
  questId: Schema.NullOr(Schema.String),
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

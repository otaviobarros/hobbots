import { CharmOperationId, HobProposal, HobProposalRowState, HobProposalState, SummoningDraft } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * Hob proposals (ADR 034, Asking is a proposal): a Summoning Charm call that asks waits for you as a
 * card with a row per hob, in the Inbox and on the call's step. You allow or deny each row, or all of
 * them, edit a summon row before you allow it, and set a field that asked to Allow with "Always
 * allow". Only a user session decides (PE-006): what is made is made by you on the manager's proposal.
 */

/** There is no such proposal, or no such row in it. */
export class HobProposalMissing extends Schema.TaggedError<HobProposalMissing>()(
  "HobProposalMissing",
  { proposalId: Schema.String, rowId: Schema.optionalKey(Schema.String) },
  { httpApiStatus: 404 },
) {}

/** The proposal settled already, or the row was decided already. */
export class HobProposalDecided extends Schema.TaggedError<HobProposalDecided>()(
  "HobProposalDecided",
  {
    proposalId: Schema.String,
    state: HobProposalState,
    rowId: Schema.optionalKey(Schema.String),
    rowState: Schema.optionalKey(HobProposalRowState),
  },
  { httpApiStatus: 409 },
) {}

/** The row's hob changed since the row was made, so it is never applied: deny it, or let the manager propose again. */
export class HobProposalChangedSince extends Schema.TaggedError<HobProposalChangedSince>()(
  "HobProposalChangedSince",
  { proposalId: Schema.String, rowId: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Retiring a hob is high risk: allowing it needs the confirmation check box (ADR 015). */
export class HobProposalNotConfirmed extends Schema.TaggedError<HobProposalNotConfirmed>()(
  "HobProposalNotConfirmed",
  { proposalId: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * What the row, as it stands or as you edited it, cannot be made as, in the words Summon and the
 * profile use, such as a name that is empty or a folder wider than the manager's. Nothing was made.
 */
export class HobProposalRefused extends Schema.TaggedError<HobProposalRefused>()(
  "HobProposalRefused",
  { proposalId: Schema.String, rowId: Schema.optionalKey(Schema.String), message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** "Always allow" is offered only for an operation that asked, never for a safety Ask or a high-risk one. */
export class HobProposalNotAlwaysAllowable extends Schema.TaggedError<HobProposalNotAlwaysAllowable>()(
  "HobProposalNotAlwaysAllowable",
  { proposalId: Schema.String, operation: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The errors deciding a proposal answers with. */
export type HobProposalError =
  | HobProposalMissing
  | HobProposalDecided
  | HobProposalChangedSince
  | HobProposalNotConfirmed
  | HobProposalRefused
  | HobProposalNotAlwaysAllowable;

/**
 * A proposal as its card shows it: the record, and the rows whose hob changed since they were made,
 * found as the card is read, so only Deny is offered for them.
 */
export const HobProposalView = Schema.Struct({
  proposal: HobProposal,
  changedSince: Schema.Array(Schema.String),
});
export type HobProposalView = typeof HobProposalView.Type;

/** The proposals that wait for you, oldest first, then the latest that settled, newest first. */
export const HobProposalsList = Schema.Struct({ proposals: Schema.Array(HobProposalView) });
export type HobProposalsList = typeof HobProposalsList.Type;

/** Allowing one row: as the manager proposed it, or a summon row as you edited it in Summon. */
export const AllowHobProposalRowPayload = Schema.Struct({
  edited: Schema.optionalKey(SummoningDraft),
  /** That you ticked the confirmation check box, which a retire row needs. */
  confirmed: Schema.optionalKey(Schema.Boolean),
});
export type AllowHobProposalRowPayload = typeof AllowHobProposalRowPayload.Type;

/** Allowing every row still pending. */
export const AllowAllHobProposalPayload = Schema.Struct({ confirmed: Schema.optionalKey(Schema.Boolean) });
export type AllowAllHobProposalPayload = typeof AllowAllHobProposalPayload.Type;

/** Setting an operation that asked to Allow on the manager's Summoning Charm. */
export const AlwaysAllowHobProposalPayload = Schema.Struct({ operation: CharmOperationId });
export type AlwaysAllowHobProposalPayload = typeof AlwaysAllowHobProposalPayload.Type;

const params = { proposalId: Schema.String };
const rowParams = { proposalId: Schema.String, rowId: Schema.String };
const errors = [
  HobProposalMissing,
  HobProposalDecided,
  HobProposalChangedSince,
  HobProposalNotConfirmed,
  HobProposalRefused,
  HobProposalNotAlwaysAllowable,
];

export class HobProposalsGroup extends HttpApiGroup.make("hobProposals")
  .add(HttpApiEndpoint.get("list", "/hob-proposals", { success: HobProposalsList }))
  .add(
    HttpApiEndpoint.get("get", "/hob-proposals/:proposalId", {
      params,
      success: HobProposalView,
      error: HobProposalMissing,
    }),
  )
  .add(
    HttpApiEndpoint.post("allow", "/hob-proposals/:proposalId/rows/:rowId/allow", {
      params: rowParams,
      payload: AllowHobProposalRowPayload,
      success: HobProposalView,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("deny", "/hob-proposals/:proposalId/rows/:rowId/deny", {
      params: rowParams,
      success: HobProposalView,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("allowAll", "/hob-proposals/:proposalId/allow-all", {
      params,
      payload: AllowAllHobProposalPayload,
      success: HobProposalView,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("denyAll", "/hob-proposals/:proposalId/deny-all", {
      params,
      success: HobProposalView,
      error: errors,
    }),
  )
  .add(
    // Sets the operation to Allow on the manager's Summoning Charm, as a change made by you.
    HttpApiEndpoint.post("alwaysAllow", "/hob-proposals/:proposalId/always-allow", {
      params,
      payload: AlwaysAllowHobProposalPayload,
      success: HobProposalView,
      error: errors,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

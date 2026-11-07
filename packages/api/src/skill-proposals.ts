import {
  SKILL_INSTRUCTIONS_MAX,
  SkillFeedback,
  SkillFlag,
  SkillId,
  SkillProposal,
  SkillProposalState,
  SkillScope,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  SkillEditStale,
  SkillImportRefused,
  SkillMissing,
  SkillNameConflict,
  SkillScanOutdated,
  SkillSourceNotRead,
} from "./skills.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * What hobs suggest for the skills library (ADR 029, Proactive hobs). A proposal waits for you in the
 * Inbox and in Skills › To review under every preset: you add it as it is, edit it then add it, or
 * say Not now. Only a user session decides (PE-006). A skill's notes from hobs are read here too.
 */

/** There is no such proposal. */
export class SkillProposalMissing extends Schema.TaggedError<SkillProposalMissing>()(
  "SkillProposalMissing",
  { proposalId: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The proposal was decided already, or is being added. */
export class SkillProposalDecided extends Schema.TaggedError<SkillProposalDecided>()(
  "SkillProposalDecided",
  { proposalId: Schema.String, state: SkillProposalState },
  { httpApiStatus: 409 },
) {}

/**
 * What the import checks find in a proposal as it would be added, before you add it: what a reader
 * is warned of (a script, a URL, hidden text), and the revision of the skill this content already
 * is, when it is one, so adding it changes nothing (the newest) or brings an earlier one back.
 */
export const SkillProposalCheck = Schema.Struct({
  flags: Schema.Array(SkillFlag),
  existing: Schema.NullOr(Schema.Int),
});
export type SkillProposalCheck = typeof SkillProposalCheck.Type;

/**
 * A proposal with what its review shows: the `SKILL.md` of the revision it changes, and the newest
 * revision's when the skill moved on since the hob read it (stale), so the change is shown against
 * it. `rollout` is where adding a revision reaches, by the assignments it would move and those held.
 * `check` is what the import checks find in it now, while it waits, and null once it is decided.
 */
export const SkillProposalView = Schema.Struct({
  proposal: SkillProposal,
  base: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(Schema.Struct({ number: Schema.Int, instructions: Schema.String })),
  rollout: Schema.NullOr(Schema.Struct({ scopes: Schema.Array(SkillScope), held: Schema.Int })),
  check: Schema.NullOr(SkillProposalCheck),
});
export type SkillProposalView = typeof SkillProposalView.Type;

/** The proposals that wait for you, then the latest you decided, newest first. */
export const SkillProposalsList = Schema.Struct({ proposals: Schema.Array(SkillProposalView) });
export type SkillProposalsList = typeof SkillProposalsList.Type;

/** Adding a proposal: as the hob wrote it, or as you edited it. */
export const AddSkillProposalPayload = Schema.Struct({
  instructions: Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(SKILL_INSTRUCTIONS_MAX)),
  ),
});
export type AddSkillProposalPayload = typeof AddSkillProposalPayload.Type;

/** Your edit of a proposal, checked as adding it would check it, before you add it. */
export const CheckSkillProposalPayload = Schema.Struct({
  instructions: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(SKILL_INSTRUCTIONS_MAX)),
});
export type CheckSkillProposalPayload = typeof CheckSkillProposalPayload.Type;

export const SkillFeedbackList = Schema.Struct({ feedback: Schema.Array(SkillFeedback) });
export type SkillFeedbackList = typeof SkillFeedbackList.Type;

const proposalParams = { proposalId: Schema.String };
const decisionErrors = [
  SkillProposalMissing,
  SkillProposalDecided,
  SkillImportRefused,
  SkillSourceNotRead,
  SkillMissing,
  SkillNameConflict,
  SkillEditStale,
  SkillScanOutdated,
];

export class SkillProposalsGroup extends HttpApiGroup.make("skillProposals")
  .add(HttpApiEndpoint.get("list", "/skill-proposals", { success: SkillProposalsList }))
  .add(
    HttpApiEndpoint.post("add", "/skill-proposals/:proposalId/add", {
      params: proposalParams,
      payload: AddSkillProposalPayload,
      success: SkillProposal,
      error: decisionErrors,
    }),
  )
  .add(
    // Writes nothing: what the checks find in your edit, as adding it would find it.
    HttpApiEndpoint.post("check", "/skill-proposals/:proposalId/check", {
      params: proposalParams,
      payload: CheckSkillProposalPayload,
      success: SkillProposalCheck,
      error: decisionErrors,
    }),
  )
  .add(
    // Not now: the library stays as it is, and the hob is told.
    HttpApiEndpoint.post("decline", "/skill-proposals/:proposalId/decline", {
      params: proposalParams,
      success: SkillProposal,
      error: decisionErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("feedback", "/skills/:skillId/feedback", {
      params: { skillId: SkillId },
      success: SkillFeedbackList,
      error: SkillMissing,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

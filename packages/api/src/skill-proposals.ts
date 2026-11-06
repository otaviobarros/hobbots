import {
  SKILL_INSTRUCTIONS_MAX,
  SkillFeedback,
  SkillId,
  SkillProposal,
  SkillProposalState,
  SkillScope,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { SkillImportRefused, SkillMissing, SkillNameConflict, SkillSourceNotRead } from "./skills.ts";
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
 * A proposal with what its review shows: the `SKILL.md` of the revision it changes, and the newest
 * revision's when the skill moved on since the hob read it (stale), so the change is shown against
 * it. `rollout` is where adding a revision reaches, by the assignments it would move and those held.
 */
export const SkillProposalView = Schema.Struct({
  proposal: SkillProposal,
  base: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(Schema.Struct({ number: Schema.Int, instructions: Schema.String })),
  rollout: Schema.NullOr(Schema.Struct({ scopes: Schema.Array(SkillScope), held: Schema.Int })),
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

import { AgentId, SkillDescription, SkillId, SkillRevisionHash, SkillTrial, Thread, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, HobUnavailable } from "./errors.ts";
import { SkillProposalMissing } from "./skill-proposals.ts";
import { importErrors } from "./skills.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * Try in a chat (ADR 029, Proactive hobs, #1099): a new chat with one hob where only a draft is
 * loaded, before anyone else gets it. The draft is a hob's proposal (with your edit, if you made
 * one), an edit you have not saved, or a new skill you have not added. It is checked as import
 * checks any skill, and nothing about it reaches the library.
 */

const SKILL_MD_MAX = 1024 * 1024;
const SkillText = Schema.String.check(Schema.isMaxLength(SKILL_MD_MAX));

export const SkillTrialDraftPayload = Schema.Union([
  /** A hob's proposal, with the whole `SKILL.md` as the card holds it now, or as proposed when absent. */
  Schema.TaggedStruct("Proposal", { proposalId: Schema.String, instructions: Schema.optionalKey(SkillText) }),
  /** An edit of `base` you have not saved: its description and the `SKILL.md` text after the front matter. */
  Schema.TaggedStruct("Edit", {
    skillId: SkillId,
    base: SkillRevisionHash,
    description: SkillDescription,
    instructions: SkillText,
  }),
  /** A new skill you have not added: its whole `SKILL.md`. */
  Schema.TaggedStruct("Written", { text: SkillText }),
]);
export type SkillTrialDraftPayload = typeof SkillTrialDraftPayload.Type;

/**
 * The draft a chat tries is gone from this hub, as after a restore, since no backup holds drafts: the
 * chat cannot load it. Opening the draft again and trying it in a new chat brings it back.
 */
export class SkillDraftGone extends Schema.TaggedError<SkillDraftGone>()(
  "SkillDraftGone",
  { threadId: ThreadId },
  { httpApiStatus: 404 },
) {}

/** The draft a chat tries and its whole `SKILL.md`, so the editor it came from opens on it again. */
export const SkillTrialText = Schema.Struct({ trial: SkillTrial, text: Schema.String });
export type SkillTrialText = typeof SkillTrialText.Type;

export class SkillTrialsGroup extends HttpApiGroup.make("skillTrials")
  .add(
    // Checks the draft and opens a new chat with the hob that loads only it: the chat comes back.
    HttpApiEndpoint.post("start", "/skill-trials", {
      payload: Schema.Struct({ agentId: AgentId, draft: SkillTrialDraftPayload }),
      success: Thread,
      error: [...importErrors, SkillProposalMissing, AgentNotFound, HobUnavailable],
    }),
  )
  .add(
    // The draft a chat tries, as it was tried, to edit further and save from where it came.
    HttpApiEndpoint.get("draft", "/skill-trials/:threadId", {
      params: { threadId: ThreadId },
      success: SkillTrialText,
      error: SkillDraftGone,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

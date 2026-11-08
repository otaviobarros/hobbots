import type { SkillTrialText } from "@hobbots/api";
import type { Agent, AgentId, SkillTrial } from "@hobbots/domain";
import { ApiError } from "../../api/client.ts";
import { messages } from "./messages.ts";
import { instructionsOf, type SkillsSearch, type SkillsView, skillsSearchOf } from "./skills-model.ts";

/** Try in a chat (ADR 029, Try in a chat, #1099): which hobs a draft can be tried with, and what a failed try says. */

const copy = messages.trial;

/** The hobs a draft can be tried with: those awake, `first` at the top when it is one of them. */
export const trialHobs = (hobs: ReadonlyArray<Agent>, first: AgentId | null): ReadonlyArray<Agent> => {
  const awake = hobs.filter((hob) => hob.status === "active");
  return [...awake.filter((hob) => hob.id === first), ...awake.filter((hob) => hob.id !== first)];
};

/** What a trial that failed says. */
export const trialErrorText = (error: unknown): string => {
  if (!(error instanceof ApiError)) return copy.failed;
  switch (error.tag) {
    case "SkillImportRefused":
      return copy.refused({ message: error.message });
    case "SkillMissing":
    case "SkillProposalMissing":
      return copy.gone;
    case "AgentNotFound":
    case "HobUnavailable":
      return copy.hobGone;
    default:
      return copy.failed;
  }
};

/** The editor a draft a chat tries came from: the proposal in To review, the skill's editor, or Write one. */
const draftView = (trial: SkillTrial): SkillsView => {
  if (trial.proposalId !== null) return { _tag: "Review", item: trial.proposalId };
  return trial.skillId === null ? { _tag: "New" } : { _tag: "Edit", skillId: trial.skillId };
};

/** The address of that editor, opened on the draft the chat `threadId` tries, to go on editing it. */
export const draftSearch = (trial: SkillTrial, threadId: string): SkillsSearch => ({
  ...skillsSearchOf(draftView(trial)),
  trial: threadId,
});

/** The fields an editor opens with from a draft you tried: its name, description and instructions. */
export const draftFields = (draft: SkillTrialText) => ({
  name: draft.trial.name as string,
  description: draft.trial.description as string,
  body: instructionsOf(draft.text),
});

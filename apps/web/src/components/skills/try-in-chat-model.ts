import type { Agent, AgentId, SkillTrial } from "@hobbots/domain";
import { ApiError } from "../../api/client.ts";
import { messages } from "./messages.ts";
import { type SkillsView, skillView } from "./skills-model.ts";

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

/** Where the draft a chat tries came from: the proposal waiting in To review, or the skill it changes. */
export const trialOrigin = (trial: SkillTrial): SkillsView | null => {
  if (trial.proposalId !== null) return { _tag: "Review", item: trial.proposalId };
  return trial.skillId === null ? null : skillView(trial.skillId);
};

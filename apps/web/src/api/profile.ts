import type { UpdateAgentPayload } from "@hobbots/api";
import type { Agent, RetireWork, RuntimeModels } from "@hobbots/domain";
import { type BrainChoice, effortWords, settleBrain } from "./first-hob.ts";

/**
 * The hob profile's editable configuration: its instructions and the model and effort it thinks
 * with. Kept apart from the screen so the edit it sends can be tested without a browser.
 */
export interface ProfileDraft extends BrainChoice {
  readonly instructions: string;
}

/** The API's limit on instructions. */
export const INSTRUCTIONS_MAX = 20_000;

// The runtime lists its own default as the "default" model, which a hob stores as no model.
const DEFAULT_MODEL = "default";
const storedModel = (model: string | null) => (model === null || model === DEFAULT_MODEL ? null : model);

/**
 * The hob's configuration as the form starts from it. With the runtime's models, a model it no
 * longer offers falls back as Summon's does, so the form only offers choices the runtime takes.
 */
export const profileDraft = (hob: Agent, models?: RuntimeModels): ProfileDraft => {
  const draft: ProfileDraft = {
    instructions: hob.instructions,
    model: hob.model ?? DEFAULT_MODEL,
    effort: hob.effort,
  };
  return models ? settleBrain(draft, models) : draft;
};

/** Only the fields the draft changes, so an untouched field never becomes a new version. */
export const profileEdit = (hob: Agent, draft: ProfileDraft): UpdateAgentPayload => {
  const model = storedModel(draft.model);
  return {
    ...(draft.instructions !== hob.instructions && { instructions: draft.instructions }),
    ...(model !== hob.model && { model }),
    ...(draft.effort !== hob.effort && { effort: draft.effort }),
  };
};

/**
 * Moves a draft onto a newer baseline, such as a version saved from another window or the answer
 * to a save. Each part the user left as it was in the old baseline takes the new value; each part
 * they changed keeps their edit. The model and effort move together, as the form picks them.
 *
 * While a save is on its way, the parts it sends stay as the user has them now, even when that is
 * back to the old baseline: the update for the save itself can arrive before the save's answer.
 */
export const rebaseDraft = (
  from: ProfileDraft,
  to: ProfileDraft,
  draft: ProfileDraft,
  sending?: ProfileDraft,
): ProfileDraft => {
  const brainChanged = (d: ProfileDraft) => d.model !== from.model || d.effort !== from.effort;
  const keepInstructions =
    draft.instructions !== from.instructions || (sending !== undefined && sending.instructions !== from.instructions);
  const keepBrain = brainChanged(draft) || (sending !== undefined && brainChanged(sending));
  return {
    instructions: keepInstructions ? draft.instructions : to.instructions,
    model: keepBrain ? draft.model : to.model,
    effort: keepBrain ? draft.effort : to.effort,
  };
};

/** Whether the draft differs from where the form started. */
export const isDirty = (base: ProfileDraft, draft: ProfileDraft): boolean =>
  base.instructions !== draft.instructions || base.model !== draft.model || base.effort !== draft.effort;

/** The brain as the header chip names it, such as "Claude · Opus · High effort". */
export const brainLine = (hob: Pick<Agent, "model" | "effort">, models?: RuntimeModels): string => {
  const id = hob.model ?? DEFAULT_MODEL;
  const model = models?.models.find((m) => m.id === id)?.displayName ?? hob.model ?? "Default model";
  const effort = hob.effort ? ` · ${effortWords(hob.effort).label} effort` : "";
  return `Claude · ${model}${effort}`;
};

/** When the hob was summoned, as "Summoned Oct 2". */
export const summonedLine = (createdAt: string): string =>
  `Summoned ${new Date(createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}`;

/** The choices Retire offers for the hob's running replies, in the order shown. */
export const RETIRE_OPTIONS: ReadonlyArray<{
  readonly work: RetireWork;
  readonly title: (name: string) => string;
  readonly note: (name: string) => string;
}> = [
  {
    work: "finish",
    title: (name) => `Let ${name} finish what it is doing`,
    note: (name) => `Replies already running finish. ${name} starts nothing new.`,
  },
  {
    work: "stop",
    title: (name) => `Stop ${name}'s work now`,
    note: () => "Running replies stop where they are. What they wrote so far is kept.",
  },
];

/** What Retire does, said once it is done. */
export const retiredSummary = (name: string, work: RetireWork, busy: boolean): string => {
  if (!busy) return `${name} is asleep. Its threads are kept and stay readable.`;
  return work === "finish"
    ? `${name} finishes the replies it was writing, then sleeps. Its threads are kept.`
    : `${name}'s running replies were stopped. Its threads are kept.`;
};

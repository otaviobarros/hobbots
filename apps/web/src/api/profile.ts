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

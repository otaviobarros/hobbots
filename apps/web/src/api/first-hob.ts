import type { CreateAgentPayload } from "@hobbots/api";
import { AgentId, type Effort, type HobColor, type RuntimeModel, type RuntimeModels } from "@hobbots/domain";

/**
 * The first hob as the user shapes it during onboarding, before the hub creates it. Kept apart
 * from the screen so the payload, defaults and dice can be tested without a browser.
 */

export type CraftKind = "helper" | "scribe" | "researcher" | "coder" | "keeper" | "custom";

export const CRAFTS: ReadonlyArray<{
  readonly kind: CraftKind;
  readonly label: string;
  readonly note: string;
  /** The name a hob of this craft starts with until the user names it. */
  readonly name: string;
}> = [
  { kind: "helper", label: "Helper", note: "Does a bit of everything.", name: "Pip" },
  { kind: "scribe", label: "Scribe", note: "Emails, notes and writing.", name: "Quill" },
  { kind: "researcher", label: "Researcher", note: "Digs through the web for answers.", name: "Bramble" },
  { kind: "coder", label: "Coder", note: "Builds and fixes code in your projects.", name: "Tinker" },
  { kind: "keeper", label: "Bookkeeper", note: "Receipts, bills and spreadsheets.", name: "Ledger" },
  { kind: "custom", label: "Your own", note: "You describe its craft in a few words.", name: "" },
];

/** Names and crafts are short enough for a name tag (the API's limit). */
export const LABEL_MAX = 40;

const HOB_NAMES = [
  "Pip",
  "Bramble",
  "Tinker",
  "Quill",
  "Moss",
  "Thistle",
  "Nib",
  "Cobble",
  "Wren",
  "Juniper",
  "Pebble",
  "Fennel",
  "Bodkin",
  "Rook",
  "Sorrel",
  "Tansy",
  "Bumble",
  "Hazel",
  "Puck",
  "Clover",
  "Nettle",
  "Acorn",
  "Mossy",
  "Grimble",
  "Fizz",
];

const EFFORT_WORDS: Readonly<Record<Effort, { label: string; note: string }>> = {
  low: { label: "Low", note: "Quick answers, saves your plan." },
  medium: { label: "Medium", note: "Thinks a bit before acting. A good default." },
  high: { label: "High", note: "Thinks longer on hard chores." },
  xhigh: { label: "Extra high", note: "Thinks much longer on the hardest chores." },
  max: { label: "Max", note: "Deepest thinking, uses the most of your plan." },
};

export const effortWords = (effort: Effort) => EFFORT_WORDS[effort];

/** Where a random pick comes from; tests pass a fixed sequence. */
export type Random = () => number;

const pick = <T>(list: ReadonlyArray<T>, random: Random): T => list[Math.floor(random() * list.length)] as T;

/** A name from the dice, never the one the hob has now. */
export const rollName = (current: string, random: Random = Math.random): string => {
  const others = HOB_NAMES.filter((name) => name !== current.trim());
  return pick(others, random);
};

/** A new look seed, never the current one; small numbers read well as "Look #4821". */
export const rollSeed = (current: number, random: Random = Math.random): number => {
  const seed = 1 + Math.floor(random() * 9998);
  return seed === current ? (seed % 9998) + 1 : seed;
};

/** Five other looks derived from the current one, for "More like this". */
export const nearbySeeds = (seed: number): ReadonlyArray<number> =>
  [1, 2, 3, 4, 5].map((k) => ((seed * 31 + k * 7919) % 9998) + 1);

export interface FirstHobDraft {
  /** The hob's id, chosen up front so a retried create returns the hob made the first time. */
  readonly id: string;
  readonly kind: CraftKind;
  /** The user's own craft, used when the kind is custom. */
  readonly craft: string;
  readonly name: string;
  /** Whether the user typed or rolled the name, so picking another craft keeps it. */
  readonly named: boolean;
  readonly lookSeed: number;
  /** The look "More like this" is drawn from; only a new look moves it, so picking one keeps the set. */
  readonly lookBase: number;
  readonly lookColor: HobColor;
  /** A model id from the runtime's list; null until the list arrives. */
  readonly model: string | null;
  readonly effort: Effort | null;
  /**
   * The create request once Continue sent it. From then on the hob may exist, so the choices stay
   * locked and every retry sends this same request; only a rejected request unlocks them.
   */
  readonly submitted: CreateAgentPayload | null;
}

export const newDraft = (
  random: Random = Math.random,
  makeId: () => string = () => crypto.randomUUID(),
): FirstHobDraft => {
  const lookSeed = rollSeed(0, random);
  return {
    id: makeId(),
    kind: "helper",
    craft: "",
    name: "Pip",
    named: false,
    lookSeed,
    lookBase: lookSeed,
    lookColor: "violet",
    model: null,
    effort: null,
    submitted: null,
  };
};

/** A draft read back from storage, completed with fields an older save may lack. */
export const restoreDraft = (stored: Partial<FirstHobDraft> | null, random: Random = Math.random): FirstHobDraft => {
  if (stored === null) return newDraft(random);
  const fresh = newDraft(random);
  const lookSeed = stored.lookSeed ?? fresh.lookSeed;
  return { ...fresh, lookBase: lookSeed, ...stored, lookSeed };
};

/** A new look from the dice, which also brings a new set of nearby looks. */
export const rollLook = (draft: FirstHobDraft, random: Random = Math.random): FirstHobDraft => {
  const lookSeed = rollSeed(draft.lookSeed, random);
  return { ...draft, lookSeed, lookBase: lookSeed };
};

/** Picking one of the nearby looks keeps the set it was picked from. */
export const pickLook = (draft: FirstHobDraft, lookSeed: number): FirstHobDraft => ({ ...draft, lookSeed });

/** Picking a craft renames an unnamed hob to that craft's usual name. */
export const pickCraft = (draft: FirstHobDraft, kind: CraftKind): FirstHobDraft => {
  const craft = CRAFTS.find((c) => c.kind === kind);
  return { ...draft, kind, name: draft.named || kind === "custom" || !craft ? draft.name : craft.name };
};

/** The effort a model starts on: medium where it takes one, else its lowest, or none. */
export const startingEffort = (model: RuntimeModel | undefined): Effort | null => {
  if (!model || model.efforts.length === 0) return null;
  return model.efforts.includes("medium") ? "medium" : (model.efforts[0] ?? null);
};

/** The runtime's own default model when it lists one, else the first. */
export const startingModel = (models: RuntimeModels): RuntimeModel | undefined =>
  models.models.find((m) => m.id === "default") ?? models.models[0];

/**
 * The draft's model and effort, settled against what the runtime offers now: a model it no
 * longer lists falls back to its default, and an effort the model does not take to its own.
 */
export const settleBrain = (draft: FirstHobDraft, models: RuntimeModels): FirstHobDraft => {
  const model = models.models.find((m) => m.id === draft.model) ?? startingModel(models);
  const effort = draft.effort !== null && model?.efforts.includes(draft.effort) ? draft.effort : startingEffort(model);
  const settled = model?.id ?? null;
  return settled === draft.model && effort === draft.effort ? draft : { ...draft, model: settled, effort };
};

/** Picking a model keeps the effort when the new model takes it. */
export const pickModel = (draft: FirstHobDraft, model: RuntimeModel): FirstHobDraft => ({
  ...draft,
  model: model.id,
  effort: draft.effort !== null && model.efforts.includes(draft.effort) ? draft.effort : startingEffort(model),
});

/** The craft as the hob carries it: the chosen craft's label, or the user's own words. */
export const craftOf = (draft: FirstHobDraft): string =>
  draft.kind === "custom" ? draft.craft.trim() : (CRAFTS.find((c) => c.kind === draft.kind)?.label ?? "");

/** What still stops the hob from being created, in words for the footer; undefined when ready. */
export const draftProblem = (draft: FirstHobDraft): string | undefined => {
  if (draft.kind === "custom" && draft.craft.trim() === "") return "Describe what your hob should be good at";
  if (draft.name.trim() === "") return "Give your hob a name";
  return undefined;
};

const instructionsFor = (name: string, kind: CraftKind, craft: string): string => {
  const note = CRAFTS.find((c) => c.kind === kind)?.note;
  return kind === "custom" || !note
    ? `You are ${name}, a hob in Hobbots. You are good at ${craft.toLowerCase()}.`
    : `You are ${name}, a hob in Hobbots. Your craft is ${craft}: ${note.toLowerCase()}`;
};

/** The create request for the draft. The runtime's "default" entry is sent as no model. */
export const firstHobPayload = (draft: FirstHobDraft): CreateAgentPayload => {
  const name = draft.name.trim();
  const craft = craftOf(draft);
  return {
    id: AgentId.make(draft.id),
    name,
    craft,
    lookSeed: draft.lookSeed,
    lookColor: draft.lookColor,
    runtime: "claude-code",
    model: draft.model === null || draft.model === "default" ? null : draft.model,
    effort: draft.effort,
    instructions: instructionsFor(name, draft.kind, craft),
  };
};

/** Locks the draft to its create request; a draft already sent keeps the request it sent. */
export const submitDraft = (draft: FirstHobDraft): FirstHobDraft & { readonly submitted: CreateAgentPayload } => ({
  ...draft,
  submitted: draft.submitted ?? firstHobPayload(draft),
});

/**
 * Unlocks a draft whose request the hub rejected. Nothing was created under its id, but a fresh one
 * keeps an edited request from ever meeting an earlier hob.
 */
export const reopenDraft = (draft: FirstHobDraft, makeId: () => string = () => crypto.randomUUID()): FirstHobDraft => ({
  ...draft,
  id: makeId(),
  submitted: null,
});

/** Where onboarding keeps the draft between steps, until the summon creates the hob. */
export const FIRST_HOB_DRAFT_KEY = "setup.firstHob";

/** The hob as the Elder Hob sums it up, such as "Pip the Helper" or "Moss, good at gardening". */
export const hobLine = (draft: FirstHobDraft): string => {
  const name = draft.name.trim() || "Your hob";
  const craft = craftOf(draft);
  return draft.kind === "custom" ? `${name}, good at ${craft.toLowerCase()}` : `${name} the ${craft}`;
};

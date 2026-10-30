import type { CreateAgentPayload } from "@hobbots/api";
import {
  type Agent,
  AgentId,
  DEFAULT_SIGIL,
  type Effort,
  type HobColor,
  type RoleId,
  type RuntimeModel,
  type RuntimeModels,
  roleFields,
  starterRole,
} from "@hobbots/domain";
import { readStored, writeStored } from "../lib/storage.ts";

/**
 * The first hob as the user shapes it during onboarding, before the hub creates it. Kept apart
 * from the screen so the payload, defaults and dice can be tested without a browser.
 */

export type CraftKind = "helper" | "scribe" | "researcher" | "coder" | "keeper" | "custom";

export const CRAFTS: ReadonlyArray<{
  readonly kind: CraftKind;
  /** The starter role the hob takes; null for a title in the user's own words. */
  readonly role: RoleId | null;
  readonly label: string;
  readonly note: string;
  /** The name a hob of this craft starts with until the user names it. */
  readonly name: string;
}> = [
  ...(
    [
      ["helper", "assistant", "Pip"],
      ["scribe", "writer", "Quill"],
      ["researcher", "researcher", "Bramble"],
      ["coder", "engineer", "Tinker"],
      ["keeper", "bookkeeper", "Ledger"],
    ] as const
  ).map(([kind, role, name]) => ({ kind, role, label: starterRole(role).title, note: starterRole(role).note, name })),
  { kind: "custom", role: null, label: "Your own", note: "You describe its role in a few words.", name: "" },
];

/** Names and crafts are short enough for a name tag (the API's limit). */
export const LABEL_MAX = 40;

/** Long enough for a few paragraphs of chores, well inside the API's instructions limit. */
export const CHORES_MAX = 4000;

/** What a hob of each craft might do, as a starting point the user edits. */
const SAMPLE_CHORES: Readonly<Record<CraftKind, string>> = {
  helper: "Help me with everyday questions and small chores. Keep answers short and ask when something is unclear.",
  scribe:
    "Draft emails and notes from my bullet points. Keep my tone friendly and brief, and show me before anything goes out.",
  researcher: "Look things up for me and answer with a short summary. Link every source you used.",
  coder: "Help me build and fix code in my projects. Explain the cause of a bug before you change anything.",
  keeper: "Help me sort receipts and bills, and list anything that does not add up.",
  custom: "",
};

export const sampleChores = (kind: CraftKind): string => SAMPLE_CHORES[kind];

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

/** The model and effort a hob thinks with, as a form holds them. */
export interface BrainChoice {
  /** A model id from the runtime's list; null until the list arrives. */
  readonly model: string | null;
  readonly effort: Effort | null;
}

export interface FirstHobDraft extends BrainChoice {
  /** The hob's id, chosen up front so a retried create returns the hob made the first time. */
  readonly id: string;
  readonly kind: CraftKind;
  /** The user's own craft, used when the kind is custom. */
  readonly craft: string;
  /** The chores in the user's own words, which Hobbots folds into the hob's instructions. */
  readonly chores: string;
  /** Whether the user typed the chores, so picking another craft keeps them. */
  readonly choresEdited: boolean;
  readonly name: string;
  /** Whether the user typed or rolled the name, so picking another craft keeps it. */
  readonly named: boolean;
  readonly lookSeed: number;
  /** The look "More like this" is drawn from; only a new look moves it, so picking one keeps the set. */
  readonly lookBase: number;
  readonly lookColor: HobColor;
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
    chores: sampleChores("helper"),
    choresEdited: false,
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

/** The starter roles the first crafts became, as the hub's migration 0010 moved them. */
const CRAFT_ROLES: ReadonlyMap<string, RoleId> = new Map([
  ["Helper", "assistant"],
  ["Scribe", "writer"],
  ["Coder", "engineer"],
  ["Researcher", "researcher"],
  ["Bookkeeper", "bookkeeper"],
]);

/**
 * A create request sent before hobs had roles, which named a craft. It moves to a role the way the
 * hub moved stored hobs, hat and tool left to the seed, so a retry still matches a hob the first
 * send created; its id and instructions stay as they were sent.
 */
const upgradeSubmitted = (submitted: CreateAgentPayload | null): CreateAgentPayload | null => {
  if (submitted === null || "roleTitle" in submitted) return submitted;
  const { craft, ...rest } = submitted as Omit<CreateAgentPayload, keyof ReturnType<typeof roleFields>> & {
    readonly craft: string;
  };
  const role = CRAFT_ROLES.get(craft);
  return role === undefined
    ? { ...rest, role: null, roleTitle: craft, sigil: DEFAULT_SIGIL, hat: null, tool: null }
    : { ...rest, ...roleFields(role), hat: null, tool: null };
};

/** A draft read back from storage, completed with fields an older save may lack. */
export const restoreDraft = (stored: Partial<FirstHobDraft> | null, random: Random = Math.random): FirstHobDraft => {
  if (stored === null) return newDraft(random);
  const fresh = newDraft(random);
  const lookSeed = stored.lookSeed ?? fresh.lookSeed;
  // A draft saved before it had chores gets its craft's sample ones.
  const chores = sampleChores(stored.kind ?? fresh.kind);
  const submitted = upgradeSubmitted(stored.submitted ?? null);
  return { ...fresh, lookBase: lookSeed, chores, ...stored, lookSeed, submitted };
};

/** A new look from the dice, which also brings a new set of nearby looks. */
export const rollLook = <D extends FirstHobDraft>(draft: D, random: Random = Math.random): D => {
  const lookSeed = rollSeed(draft.lookSeed, random);
  return { ...draft, lookSeed, lookBase: lookSeed };
};

/** Picking one of the nearby looks keeps the set it was picked from. */
export const pickLook = <D extends FirstHobDraft>(draft: D, lookSeed: number): D => ({ ...draft, lookSeed });

/** Picking a craft brings its usual name and sample chores, unless the user wrote their own. */
export const pickCraft = <D extends FirstHobDraft>(draft: D, kind: CraftKind): D => {
  const craft = CRAFTS.find((c) => c.kind === kind);
  return {
    ...draft,
    kind,
    name: draft.named || kind === "custom" || !craft ? draft.name : craft.name,
    chores: draft.choresEdited ? draft.chores : sampleChores(kind),
  };
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
export const settleBrain = <D extends BrainChoice>(draft: D, models: RuntimeModels): D => {
  const model = models.models.find((m) => m.id === draft.model) ?? startingModel(models);
  const effort = draft.effort !== null && model?.efforts.includes(draft.effort) ? draft.effort : startingEffort(model);
  const settled = model?.id ?? null;
  return settled === draft.model && effort === draft.effort ? draft : { ...draft, model: settled, effort };
};

/**
 * The runtime's main models, shown first, and the rest, offered behind "More models". A runtime
 * that marks none as main has all of them shown.
 */
export const splitModels = (
  models: ReadonlyArray<RuntimeModel>,
): { readonly main: ReadonlyArray<RuntimeModel>; readonly more: ReadonlyArray<RuntimeModel> } => {
  const main = models.filter((m) => m.main);
  return main.length === 0 ? { main: models, more: [] } : { main, more: models.filter((m) => !m.main) };
};

/** Picking a model keeps the effort when the new model takes it. */
export const pickModel = <D extends BrainChoice>(draft: D, model: RuntimeModel): D => ({
  ...draft,
  model: model.id,
  effort: draft.effort !== null && model.efforts.includes(draft.effort) ? draft.effort : startingEffort(model),
});

const roleOf = (draft: FirstHobDraft): RoleId | null => CRAFTS.find((c) => c.kind === draft.kind)?.role ?? null;

/** The role title as the hob carries it: the starter role's title, or the user's own words. */
export const roleTitleOf = (draft: FirstHobDraft): string => {
  const role = roleOf(draft);
  return role === null ? draft.craft.trim() : starterRole(role).title;
};

/** The hat and tool the draft's role dresses the hob in; a title of the user's own leaves them to the seed. */
export const gearOf = (draft: FirstHobDraft): Required<Pick<Agent, "hat" | "tool">> => {
  const role = roleOf(draft);
  return role === null ? { hat: null, tool: null } : { hat: starterRole(role).hat, tool: starterRole(role).tool };
};

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
    : `You are ${name}, a hob in Hobbots. Your role is ${craft}: ${note.toLowerCase()}`;
};

/**
 * The create request for the draft, with the chores added to the instructions when there are any.
 * The runtime's "default" entry is sent as no model.
 */
export const firstHobPayload = (draft: FirstHobDraft): CreateAgentPayload => {
  const name = draft.name.trim();
  const title = roleTitleOf(draft);
  const role = roleOf(draft);
  const chores = draft.chores.trim();
  const instructions = instructionsFor(name, draft.kind, title);
  return {
    id: AgentId.make(draft.id),
    name,
    ...(role === null
      ? { role: null, roleTitle: title, sigil: DEFAULT_SIGIL, hat: null, tool: null }
      : roleFields(role)),
    lookSeed: draft.lookSeed,
    lookColor: draft.lookColor,
    runtime: "claude-code",
    model: draft.model === null || draft.model === "default" ? null : draft.model,
    effort: draft.effort,
    instructions: chores ? `${instructions}\n\nYour chores, in the user's words:\n${chores}` : instructions,
  };
};

/** Locks the draft to its create request; a draft already sent keeps the request it sent. */
export const submitDraft = <D extends FirstHobDraft>(draft: D): D & { readonly submitted: CreateAgentPayload } => ({
  ...draft,
  submitted: draft.submitted ?? firstHobPayload(draft),
});

/**
 * Unlocks a draft whose request the hub rejected. Nothing was created under its id, but a fresh one
 * keeps an edited request from ever meeting an earlier hob.
 */
export const reopenDraft = <D extends FirstHobDraft>(
  draft: D,
  makeId: () => string = () => crypto.randomUUID(),
): D => ({
  ...draft,
  id: makeId(),
  submitted: null,
});

/**
 * A draft kept for this window under a storage key. It lives in memory, so the form works when
 * browser storage is blocked or full; storage only brings it back after a reload.
 */
const draftKeeper = (key: string) => {
  // Undefined means "not set in this window".
  let kept: Partial<FirstHobDraft> | null | undefined;
  const read = (): Partial<FirstHobDraft> | null =>
    kept !== undefined ? kept : readStored<Partial<FirstHobDraft> | null>(key, null);
  const keep = (draft: FirstHobDraft | null) => {
    kept = draft;
    writeStored(key, draft);
  };
  return {
    /** Keeps the draft, or forgets it with null once the hob exists. */
    keep,
    /** The draft kept in this window, else the one browser storage remembers, else null. */
    kept: read,
    /**
     * Replaces the draft only while it is still the one sent under `id`. A request that settles
     * after the user started another draft leaves that newer draft alone.
     */
    settle: (id: string, next: FirstHobDraft | null) => {
      if (read()?.id === id) keep(next);
    },
  };
};

/** Where onboarding keeps the draft between steps, until the summon creates the hob. */
export const FIRST_HOB_DRAFT_KEY = "setup.firstHob";

const firstHob = draftKeeper(FIRST_HOB_DRAFT_KEY);
export const keepDraft = firstHob.keep;
export const keptDraftOrStored = firstHob.kept;

/** Where Summon keeps its draft while the user looks elsewhere, until the hob exists. */
export const SUMMON_DRAFT_KEY = "summon.draft";

const summoning = draftKeeper(SUMMON_DRAFT_KEY);
export const keepSummonDraft = summoning.keep;
export const keptSummonDraft = summoning.kept;
export const settleSummonDraft = summoning.settle;

/** The model and effort the hob thinks with, such as "Claude · Sonnet · medium effort". */
export const thinksWith = (draft: FirstHobDraft, model: RuntimeModel | undefined): string =>
  `Claude · ${model?.displayName ?? "…"}${draft.effort ? ` · ${effortWords(draft.effort).label.toLowerCase()} effort` : ""}`;

/** What the hob's line says after its name, such as "the Writer" or "good at gardening". */
export const kindLine = (draft: FirstHobDraft): string => {
  if (draft.kind !== "custom") return `the ${CRAFTS.find((c) => c.kind === draft.kind)?.label ?? ""}`;
  const craft = draft.craft.trim();
  return craft ? `good at ${craft.toLowerCase()}` : "one of a kind";
};

/** The hob as the Elder Hob sums it up, such as "Pip the Assistant" or "Moss, good at gardening". */
export const hobLine = (draft: FirstHobDraft): string => {
  const name = draft.name.trim() || "Your hob";
  const title = roleTitleOf(draft);
  return draft.kind === "custom" ? `${name}, good at ${title.toLowerCase()}` : `${name} the ${title}`;
};

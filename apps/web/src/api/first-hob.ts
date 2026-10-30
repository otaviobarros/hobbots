import type { CreateAgentPayload } from "@hobbots/api";
import {
  type Agent,
  AgentId,
  DEFAULT_SIGIL,
  type Effort,
  type HobColor,
  PICKER_FIRST,
  ROLE_FAMILIES,
  type RoleFamily,
  type RoleHat,
  type RoleId,
  type RoleTool,
  type RuntimeModel,
  type RuntimeModels,
  roleFields,
  STARTER_ROLES,
  starterRole,
} from "@hobbots/domain";
import { readStored, writeStored } from "../lib/storage.ts";

/**
 * The first hob as the user shapes it during onboarding, before the hub creates it. Kept apart
 * from the screen so the payload, defaults and dice can be tested without a browser.
 */

/** Every starter role, in the order the sigil choices list them. */
export const ALL_ROLES: ReadonlyArray<RoleId> = STARTER_ROLES.map((role) => role.id);

/** Every starter role the picker does not show first, under its family, for "More roles". */
export const MORE_ROLES: ReadonlyArray<{
  readonly family: RoleFamily;
  readonly title: string;
  readonly roles: ReadonlyArray<RoleId>;
}> = ROLE_FAMILIES.map(({ id, title }) => ({
  family: id,
  title,
  roles: ALL_ROLES.filter((role) => starterRole(role).family === id && !PICKER_FIRST.includes(role)),
})).filter((group) => group.roles.length > 0);

/** A family of starter roles as the role sheet lists it. */
export interface RoleGroup {
  readonly family: RoleFamily;
  readonly title: string;
  readonly roles: ReadonlyArray<RoleId>;
}

/**
 * Every starter role under its family, narrowed to one family (or `"all"`) and to the roles whose
 * title or note holds every word of the search, in any case. Families left empty are dropped.
 */
export const roleGroups = (search: string, family: RoleFamily | "all" = "all"): ReadonlyArray<RoleGroup> => {
  const words = search
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const matches = (id: RoleId) => {
    const role = starterRole(id);
    const text = `${role.title} ${role.note}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  return ROLE_FAMILIES.filter(({ id }) => family === "all" || id === family)
    .map(({ id, title }) => ({
      family: id,
      title,
      roles: ALL_ROLES.filter((role) => starterRole(role).family === id && matches(role)),
    }))
    .filter((group) => group.roles.length > 0);
};

/** Names and role titles are short enough for a name tag (the API's limit). */
export const LABEL_MAX = 40;

/** Long enough for a few paragraphs of chores, well inside the API's instructions limit. */
export const CHORES_MAX = 4000;

/** What a hob in each starter role might do, as a starting point the user edits. */
const SAMPLE_CHORES: Readonly<Record<RoleId, string>> = {
  assistant: "Help me with everyday questions and small chores. Keep answers short and ask when something is unclear.",
  researcher: "Look things up for me and answer with a short summary. Link every source you used.",
  writer:
    "Draft emails and notes from my bullet points. Keep my tone friendly and brief, and show me before anything goes out.",
  editor: "Read what I wrote and tighten it. Fix mistakes, keep my voice, and tell me what you changed.",
  translator: "Translate what I send you and keep the tone. Point out phrases that do not carry over well.",
  notetaker: "Turn my meeting notes and transcripts into a short summary with decisions and to-dos.",
  brainstormer: "Help me come up with ideas when I'm stuck. Give me a few different directions, not just one.",
  organizer: "Help me sort and rename files in my folders. Show me the plan before you move anything.",
  ceo: "Help me set goals and decide what matters most this week. Push back when I take on too much.",
  cto: "Help me make technical decisions and plan the work for the dev team. Explain the trade-offs.",
  cfo: "Watch the numbers with me: spending, forecasts and runway. Flag anything that looks off.",
  cmo: "Help me shape the brand, the story we tell and the plan to grow. Keep it honest and simple.",
  coo: "Help me keep day-to-day operations running. List what is stuck and who should unblock it.",
  chiefofstaff: "Keep track of my priorities and follow-ups. Remind me what I promised and to whom.",
  techlead: "Plan the work, split it into small tasks and review the results before they ship.",
  engineer: "Help me build and fix code in my projects. Explain the cause of a bug before you change anything.",
  frontend: "Build and fix the screens in my app. Keep them accessible and match the design.",
  backend: "Build and fix APIs, databases and server code. Write tests for every change.",
  platform: "Keep builds, deploys and servers healthy. Tell me before you change anything that runs in production.",
  qa: "Test what I build and find what breaks. Write down the steps to reproduce each bug.",
  reviewer: "Review my changes before I merge them. Flag bugs and risks first, style last.",
  security: "Look for weak spots in my code and settings. Explain each risk and how to fix it.",
  dataeng: "Help me move and clean data, and write the queries. Check the results before you trust them.",
  aieng: "Help me build prompts, agents and AI features. Test them on real examples.",
  techwriter: "Write and update docs, READMEs and runbooks. Keep them short and easy to follow.",
  exec: "Help me triage my inbox and plan my calendar. Draft replies, and check with me before anything is sent.",
  analyst: "Help me make sense of my spreadsheets. Answer with the numbers and a simple chart when it helps.",
  pm: "Keep track of tasks and deadlines. Give me a short status update and list what is late.",
  product: "Help me decide what to build next and why. Ask who it is for before you suggest anything.",
  advisor: "Talk through my business plans, pricing and strategy with me. Be direct about the risks.",
  finance: "Help me model the numbers and read the markets. Explain the risks in plain words.",
  bookkeeper: "Help me sort receipts and bills, and list anything that does not add up.",
  sales: "Help me find leads and draft friendly outreach. Keep messages short and personal.",
  marketer: "Write campaigns, ads and launch posts with me. Keep them true to what we actually offer.",
  support: "Draft kind, clear answers to customer questions. Tell me when you are not sure of the answer.",
  recruiter: "Help me write job posts and sort through candidates. Keep it fair and focused on the role.",
  paralegal: "Read contracts with me and flag clauses to check. You are not a lawyer, so say when I need one.",
  tutor: "Explain things to me step by step, at my pace. Check that I understood before moving on.",
  language: "Practice a new language with me every day. Correct my mistakes gently.",
  course: "Help me build lessons, quizzes and study guides. Start with what the learner should be able to do.",
  scientist: "Read papers with me, check the methods and run the numbers. Say how sure you are.",
  designer: "Sketch layouts and visual ideas with me. Explain why each choice works.",
  fiction: "Write stories with me. Help with worlds, characters and plot, and keep my style.",
  creator: "Help me plan videos, podcasts and blog posts. Suggest titles and a rough outline.",
  gamemaster: "Run games, puzzles and tabletop adventures for me and my friends. Keep it fun and fair.",
  lifeorg: "Keep my lists, routines and plans in one place. Remind me what is coming up.",
  health: "Help me build better habits for sleep, food and exercise. You are not a doctor, so say when I need one.",
  lifecoach: "Talk through choices, goals and tough days with me. Ask questions before you give advice.",
  chef: "Plan meals with me and find recipes for what is in my fridge. Keep them simple.",
  travel: "Plan trips with me: routes, places to stay and packing lists. Keep a rough budget.",
  money: "Help me with my budget, bills and tax season. Explain things in plain words.",
  career: "Help me polish my CV and prepare for interviews. Be honest about what to improve.",
  household: "Keep track of chores, repairs and home paperwork. Remind me before things are due.",
  family: "Help me juggle school dates, family plans and the kids' activities.",
};

/** The sample chores a role starts with; a title of the user's own starts empty. */
export const sampleChores = (role: RoleId | null): string => (role === null ? "" : SAMPLE_CHORES[role]);

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
  /** The starter role picked, or null for "Your own". */
  readonly role: RoleId | null;
  /** The role title in the user's own words, used when the role is null. */
  readonly ownTitle: string;
  /** The starter role whose sigil a title of the user's own borrows. */
  readonly ownSigil: RoleId;
  /** The hat the sprite wears; picking a role brings its own, and null leaves it to the look seed. */
  readonly hat: RoleHat | null;
  /** The tool the sprite holds; picking a role brings its own, and null leaves it to the look seed. */
  readonly tool: RoleTool | null;
  /** The chores in the user's own words, which Hobbots folds into the hob's instructions. */
  readonly chores: string;
  /** Whether the user typed the chores, so picking another role keeps them. */
  readonly choresEdited: boolean;
  readonly name: string;
  /** Whether the user typed or rolled the name. */
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
  const role: RoleId = "assistant";
  return {
    id: makeId(),
    role,
    ownTitle: "",
    ownSigil: DEFAULT_SIGIL,
    hat: starterRole(role).hat,
    tool: starterRole(role).tool,
    chores: sampleChores(role),
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

/** The starter roles a draft's craft became when the picker replaced the crafts. */
const DRAFT_CRAFT_ROLES: ReadonlyMap<string, RoleId> = new Map([
  ["helper", "assistant"],
  ["scribe", "writer"],
  ["researcher", "researcher"],
  ["coder", "engineer"],
  ["keeper", "bookkeeper"],
]);

/**
 * A draft saved before the role picker, which held a craft kind and the user's own craft, moves to
 * the matching role with its hat and tool, or to a title of the user's own with the seed's gear.
 */
const upgradeDraft = (stored: Partial<FirstHobDraft>): Partial<FirstHobDraft> => {
  if ("role" in stored) return stored;
  const { kind, craft, ...rest } = stored as Partial<FirstHobDraft> & { kind?: string; craft?: string };
  if (kind === undefined) return rest;
  const role = DRAFT_CRAFT_ROLES.get(kind) ?? null;
  return role === null
    ? { ...rest, role: null, ownTitle: craft ?? "", ownSigil: DEFAULT_SIGIL, hat: null, tool: null }
    : { ...rest, role, hat: starterRole(role).hat, tool: starterRole(role).tool };
};

/** A draft read back from storage, completed with fields an older save may lack. */
export const restoreDraft = (saved: Partial<FirstHobDraft> | null, random: Random = Math.random): FirstHobDraft => {
  if (saved === null) return newDraft(random);
  const stored = upgradeDraft(saved);
  const fresh = newDraft(random);
  const lookSeed = stored.lookSeed ?? fresh.lookSeed;
  const role = stored.role === undefined ? fresh.role : stored.role;
  // A draft saved before it had chores gets its role's sample ones.
  const chores = sampleChores(role);
  const gear = role === null ? { hat: null, tool: null } : { hat: starterRole(role).hat, tool: starterRole(role).tool };
  const submitted = upgradeSubmitted(stored.submitted ?? null);
  return { ...fresh, lookBase: lookSeed, chores, ...gear, ...stored, role, lookSeed, submitted };
};

/** A new look from the dice, which also brings a new set of nearby looks. */
export const rollLook = <D extends FirstHobDraft>(draft: D, random: Random = Math.random): D => {
  const lookSeed = rollSeed(draft.lookSeed, random);
  return { ...draft, lookSeed, lookBase: lookSeed };
};

/** Picking one of the nearby looks keeps the set it was picked from. */
export const pickLook = <D extends FirstHobDraft>(draft: D, lookSeed: number): D => ({ ...draft, lookSeed });

/**
 * Picking a starter role dresses the hob in its hat and tool and brings its sample chores, unless
 * the user wrote their own. Picking "Your own" (null) leaves the hat and tool to the look seed.
 */
export const pickRole = <D extends FirstHobDraft>(draft: D, role: RoleId | null): D => ({
  ...draft,
  role,
  hat: role === null ? null : starterRole(role).hat,
  tool: role === null ? null : starterRole(role).tool,
  chores: draft.choresEdited ? draft.chores : sampleChores(role),
});

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

/** The role title as the hob carries it: the starter role's title, or the user's own words. */
export const roleTitleOf = (draft: FirstHobDraft): string =>
  draft.role === null ? draft.ownTitle.trim() : starterRole(draft.role).title;

/** The sigil the hob shows: its starter role's, or the one a title of the user's own borrows. */
export const sigilOf = (draft: FirstHobDraft): RoleId => draft.role ?? draft.ownSigil;

/** The hat and tool the sprite wears; null leaves them to the look seed. */
export const gearOf = (draft: FirstHobDraft): Required<Pick<Agent, "hat" | "tool">> => ({
  hat: draft.hat,
  tool: draft.tool,
});

/** What still stops the hob from being created, in words for the footer; undefined when ready. */
export const draftProblem = (draft: FirstHobDraft): string | undefined => {
  if (draft.role === null && draft.ownTitle.trim() === "") return "Give your hob's role a title";
  if (draft.name.trim() === "") return "Give your hob a name";
  return undefined;
};

/** The instructions' first line, which names the hob and its role. The profile rewrites it when the role changes. */
export const openingLine = (name: string, role: RoleId | null, title: string): string =>
  role === null
    ? `You are ${name}, a hob in Hobbots. Your role is ${title}.`
    : `You are ${name}, a hob in Hobbots. Your role is ${title}: ${starterRole(role).note.toLowerCase()}`;

/**
 * The create request for the draft, with the chores added to the instructions when there are any.
 * The runtime's "default" entry is sent as no model.
 */
export const firstHobPayload = (draft: FirstHobDraft): CreateAgentPayload => {
  const name = draft.name.trim();
  const title = roleTitleOf(draft);
  const { role } = draft;
  const chores = draft.chores.trim();
  const instructions = openingLine(name, role, title);
  return {
    id: AgentId.make(draft.id),
    name,
    ...(role === null ? { role: null, roleTitle: title, sigil: draft.ownSigil } : roleFields(role)),
    // The hat and tool as the user left them next to the look, which may differ from the role's.
    hat: draft.hat,
    tool: draft.tool,
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

/** What the hob's line says after its name, such as "the Writer", or "one of a kind" before a title. */
export const kindLine = (draft: FirstHobDraft): string => {
  const title = roleTitleOf(draft);
  return title ? `the ${title}` : "one of a kind";
};

/** The hob as the Elder Hob sums it up, such as "Fern the Frontend engineer". */
export const hobLine = (draft: FirstHobDraft): string => {
  const name = draft.name.trim() || "Your hob";
  const title = roleTitleOf(draft);
  return title ? `${name} the ${title}` : name;
};

/** The role request form on GitHub, for a role the starter set lacks. */
const ROLE_REQUEST_FORM = "https://github.com/otaviobarros/hobbots/issues/new?template=5-role-request.yml";

/** The role request form, with the title filled in from what the user typed as their own. */
export const roleRequestUrl = (ownTitle: string): string => {
  const title = ownTitle.trim();
  if (!title) return ROLE_REQUEST_FORM;
  const query = new URLSearchParams({ title: `Role: ${title}`, "role-title": title });
  return `${ROLE_REQUEST_FORM}&${query.toString()}`;
};

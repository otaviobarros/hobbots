import type { UpdateAgentPayload } from "@hobbots/api";
import {
  type Agent,
  type HobColor,
  type ReplyLength,
  type RetireWork,
  type RoleHat,
  type RoleId,
  type RoleTool,
  type RuntimeModels,
  roleFields,
  starterRole,
  type Voice,
} from "@hobbots/domain";
import { formatMonthDay } from "../lib/format.ts";
import { type BrainChoice, settleBrain } from "./first-hob.ts";

/** A hob's role as the profile edits it: a starter role, or a title in the user's own words. */
export interface RoleChoice {
  readonly role: RoleId | null;
  readonly roleTitle: string;
  readonly sigil: RoleId;
  readonly hat: RoleHat | null;
  readonly tool: RoleTool | null;
}

/**
 * The hob profile's editable configuration: its name and look, its role, its tone, its instructions,
 * whether other hobs see it, and the model and effort it thinks with. Kept apart from the screen so the edit it sends can be
 * tested without a browser.
 */
export interface ProfileDraft extends BrainChoice, RoleChoice {
  readonly name: string;
  readonly lookSeed: number;
  readonly lookColor: HobColor;
  readonly voice: Voice;
  readonly length: ReplyLength;
  readonly instructions: string;
  /** Whether other hobs see this hob in their directory. */
  readonly visibleToHobs: boolean;
}

const ROLE_KEYS = ["role", "roleTitle", "sigil", "hat", "tool"] as const;
// The parts of a draft that move on their own when it is rebased.
const OWN_KEYS = ["name", "lookSeed", "lookColor", "voice", "length", "visibleToHobs"] as const;
type OwnKey = (typeof OWN_KEYS)[number];

/**
 * Picks a starter role, which brings its title, sigil, hat and tool, or the user's own words
 * (`null`), which keep the title, sigil, hat and tool the hob has until the user changes them.
 */
export const pickRole = <D extends RoleChoice>(draft: D, role: RoleId | null): D =>
  role === null ? { ...draft, role: null } : { ...draft, ...roleFields(role) };

/** Why the role cannot be saved as it is, or undefined when it can. */
export const roleProblem = (draft: RoleChoice): string | undefined =>
  draft.roleTitle.trim() === "" ? "Give the role a title." : undefined;

/** The API's limit on a hob's name. */
export const NAME_MAX = 40;

/** Why the draft cannot be saved as it is, or undefined when it can. */
export const draftProblem = (draft: ProfileDraft): string | undefined =>
  draft.name.trim() === "" ? "Give the hob a name." : roleProblem(draft);

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
    name: hob.name,
    lookSeed: hob.lookSeed,
    lookColor: hob.lookColor,
    role: hob.role,
    roleTitle: hob.roleTitle,
    sigil: hob.sigil,
    hat: hob.hat,
    tool: hob.tool,
    voice: hob.voice,
    length: hob.length,
    instructions: hob.instructions,
    visibleToHobs: hob.visibleToHobs,
    runtime: hob.runtime,
    model: hob.model ?? DEFAULT_MODEL,
    effort: hob.effort,
  };
  return models ? settleBrain(draft, models) : draft;
};

// The name, look and color the draft changes.
const lookEdit = (hob: Agent, draft: ProfileDraft): UpdateAgentPayload => {
  const name = draft.name.trim();
  return {
    ...(name !== hob.name && { name }),
    ...(draft.lookSeed !== hob.lookSeed && { lookSeed: draft.lookSeed }),
    ...(draft.lookColor !== hob.lookColor && { lookColor: draft.lookColor }),
  };
};

/** Only the fields the draft changes, so an untouched field never becomes a new version. */
export const profileEdit = (hob: Agent, draft: ProfileDraft): UpdateAgentPayload => {
  const model = storedModel(draft.model);
  const role: RoleChoice = { ...draft, roleTitle: draft.roleTitle.trim() };
  // The hub checks the model and effort against the runtime, so a new runtime sends both.
  const newRuntime = draft.runtime !== hob.runtime;
  return {
    ...lookEdit(hob, draft),
    ...(role.role !== hob.role && { role: role.role }),
    ...(role.roleTitle !== hob.roleTitle && { roleTitle: role.roleTitle }),
    ...(role.sigil !== hob.sigil && { sigil: role.sigil }),
    ...(role.hat !== hob.hat && { hat: role.hat }),
    ...(role.tool !== hob.tool && { tool: role.tool }),
    ...(draft.voice !== hob.voice && { voice: draft.voice }),
    ...(draft.length !== hob.length && { length: draft.length }),
    ...(draft.instructions !== hob.instructions && { instructions: draft.instructions }),
    ...(draft.visibleToHobs !== hob.visibleToHobs && { visibleToHobs: draft.visibleToHobs }),
    ...(newRuntime && { runtime: draft.runtime }),
    ...((newRuntime || model !== hob.model) && { model }),
    ...((newRuntime || draft.effort !== hob.effort) && { effort: draft.effort }),
  };
};

/**
 * Moves a draft onto a newer baseline, such as a version saved from another window or the answer
 * to a save. Each part the user left as it was in the old baseline takes the new value; each part
 * they changed keeps their edit. The provider, model and effort move together, as the form picks them, and so
 * do the role's title, sigil, hat and tool. The name, the look, the color, the voice, the length
 * and being visible to other hobs move on their own.
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
  const brainChanged = (d: ProfileDraft) =>
    d.runtime !== from.runtime || d.model !== from.model || d.effort !== from.effort;
  const keepInstructions =
    draft.instructions !== from.instructions || (sending !== undefined && sending.instructions !== from.instructions);
  const keepBrain = brainChanged(draft) || (sending !== undefined && brainChanged(sending));
  const roleChanged = (d: ProfileDraft) => ROLE_KEYS.some((key) => d[key] !== from[key]);
  const keepRole = roleChanged(draft) || (sending !== undefined && roleChanged(sending));
  const role = keepRole ? draft : to;
  const keep = <K extends OwnKey>(key: K) =>
    draft[key] !== from[key] || (sending !== undefined && sending[key] !== from[key]) ? draft[key] : to[key];
  return {
    name: keep("name"),
    lookSeed: keep("lookSeed"),
    lookColor: keep("lookColor"),
    role: role.role,
    roleTitle: role.roleTitle,
    sigil: role.sigil,
    hat: role.hat,
    tool: role.tool,
    voice: keep("voice"),
    length: keep("length"),
    instructions: keepInstructions ? draft.instructions : to.instructions,
    visibleToHobs: keep("visibleToHobs"),
    runtime: keepBrain ? draft.runtime : to.runtime,
    model: keepBrain ? draft.model : to.model,
    effort: keepBrain ? draft.effort : to.effort,
  };
};

// Every part of the form, each counted as one change when the draft moves it.
const DRAFT_KEYS = [...OWN_KEYS, ...ROLE_KEYS, "instructions", "runtime", "model", "effort"] as const;

/**
 * How many parts of the form the draft changes from where the form started. It compares with the
 * form's starting point, not the saved hob, so a model and effort the form settles on its own do
 * not count as the user's edits.
 */
export const changeCount = (base: ProfileDraft, draft: ProfileDraft): number =>
  DRAFT_KEYS.filter((key) => base[key] !== draft[key]).length;

/** Whether the draft differs from where the form started. */
export const isDirty = (base: ProfileDraft, draft: ProfileDraft): boolean => changeCount(base, draft) > 0;

// Summon and onboarding fold the chores into the instructions under this line (see first-hob.ts).
const CHORES_HEADING = "Your chores, in the user's words:\n";

/**
 * What the hob is good at, for the profile's role chip: the chores the user gave it, or else its
 * starter role's note. Undefined for a title in the user's own words with no chores.
 */
export const goodAt = (hob: Pick<Agent, "instructions" | "role">): string | undefined => {
  const at = hob.instructions.lastIndexOf(CHORES_HEADING);
  const chores =
    at === -1
      ? ""
      : hob.instructions
          .slice(at + CHORES_HEADING.length)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .join(" ");
  if (chores !== "") return chores;
  return hob.role === null ? undefined : starterRole(hob.role).note;
};

/** Where the hob works, when it was summoned and its version, for the line under the profile. */
export const aboutLine = (hob: Pick<Agent, "createdAt" | "configVersion">): string =>
  `Works on the hub · ${summonedLine(hob.createdAt)} · Version ${hob.configVersion}`;

/** When the hob was summoned, as "Summoned Oct 2". */
const summonedLine = (createdAt: string): string => `Summoned ${formatMonthDay(new Date(createdAt))}`;

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

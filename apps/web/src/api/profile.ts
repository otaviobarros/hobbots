import type { UpdateAgentPayload } from "@hobbots/api";
import {
  type Agent,
  type RetireWork,
  type RoleHat,
  type RoleId,
  type RoleTool,
  type RuntimeModels,
  roleFields,
  starterRole,
} from "@hobbots/domain";
import { type BrainChoice, effortWords, settleBrain } from "./first-hob.ts";

/** A hob's role as the profile edits it: a starter role, or a title in the user's own words. */
export interface RoleChoice {
  readonly role: RoleId | null;
  readonly roleTitle: string;
  readonly sigil: RoleId;
  readonly hat: RoleHat | null;
  readonly tool: RoleTool | null;
}

/**
 * The hob profile's editable configuration: its role, its instructions and the model and effort it
 * thinks with. Kept apart from the screen so the edit it sends can be tested without a browser.
 */
export interface ProfileDraft extends BrainChoice, RoleChoice {
  readonly instructions: string;
}

const ROLE_KEYS = ["role", "roleTitle", "sigil", "hat", "tool"] as const;

/**
 * Picks a starter role, which brings its title, sigil, hat and tool, or the user's own words
 * (`null`), which keep the title, sigil, hat and tool the hob has until the user changes them.
 */
export const pickRole = <D extends RoleChoice>(draft: D, role: RoleId | null): D =>
  role === null ? { ...draft, role: null } : { ...draft, ...roleFields(role) };

/** The API's limit on a role title. */
export const ROLE_TITLE_MAX = 40;

/** Why the role cannot be saved as it is, or undefined when it can. */
export const roleProblem = (draft: RoleChoice): string | undefined =>
  draft.roleTitle.trim() === "" ? "Give the role a title." : undefined;

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
    role: hob.role,
    roleTitle: hob.roleTitle,
    sigil: hob.sigil,
    hat: hob.hat,
    tool: hob.tool,
    instructions: hob.instructions,
    model: hob.model ?? DEFAULT_MODEL,
    effort: hob.effort,
  };
  return models ? settleBrain(draft, models) : draft;
};

/** Only the fields the draft changes, so an untouched field never becomes a new version. */
export const profileEdit = (hob: Agent, draft: ProfileDraft): UpdateAgentPayload => {
  const model = storedModel(draft.model);
  const role: RoleChoice = { ...draft, roleTitle: draft.roleTitle.trim() };
  return {
    ...(role.role !== hob.role && { role: role.role }),
    ...(role.roleTitle !== hob.roleTitle && { roleTitle: role.roleTitle }),
    ...(role.sigil !== hob.sigil && { sigil: role.sigil }),
    ...(role.hat !== hob.hat && { hat: role.hat }),
    ...(role.tool !== hob.tool && { tool: role.tool }),
    ...(draft.instructions !== hob.instructions && { instructions: draft.instructions }),
    ...(model !== hob.model && { model }),
    ...(draft.effort !== hob.effort && { effort: draft.effort }),
  };
};

/**
 * Moves a draft onto a newer baseline, such as a version saved from another window or the answer
 * to a save. Each part the user left as it was in the old baseline takes the new value; each part
 * they changed keeps their edit. The model and effort move together, as the form picks them, and so
 * do the role's title, sigil, hat and tool.
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
  const roleChanged = (d: ProfileDraft) => ROLE_KEYS.some((key) => d[key] !== from[key]);
  const keepRole = roleChanged(draft) || (sending !== undefined && roleChanged(sending));
  const role = keepRole ? draft : to;
  return {
    role: role.role,
    roleTitle: role.roleTitle,
    sigil: role.sigil,
    hat: role.hat,
    tool: role.tool,
    instructions: keepInstructions ? draft.instructions : to.instructions,
    model: keepBrain ? draft.model : to.model,
    effort: keepBrain ? draft.effort : to.effort,
  };
};

/** Whether the draft differs from where the form started. */
export const isDirty = (base: ProfileDraft, draft: ProfileDraft): boolean =>
  ROLE_KEYS.some((key) => base[key] !== draft[key]) ||
  base.instructions !== draft.instructions ||
  base.model !== draft.model ||
  base.effort !== draft.effort;

/** The brain as the header chip names it, such as "Claude · Opus · High effort". */
export const brainLine = (hob: Pick<Agent, "model" | "effort">, models?: RuntimeModels): string => {
  const id = hob.model ?? DEFAULT_MODEL;
  const model = models?.models.find((m) => m.id === id)?.displayName ?? hob.model ?? "Default model";
  const effort = hob.effort ? ` · ${effortWords(hob.effort).label} effort` : "";
  return `Claude · ${model}${effort}`;
};

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

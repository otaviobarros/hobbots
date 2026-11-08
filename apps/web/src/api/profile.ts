import type { HandOverBlock, RetireAgentPayload, UpdateAgentPayload } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  GOOD_AT_MAX,
  type HobColor,
  normalizeGoodAt,
  type ReplyLength,
  type RetireOpenWork,
  type RetireWork,
  type RoleHat,
  type RoleId,
  type RoleTool,
  type RuntimeModels,
  roleFields,
  starterRole,
  type Voice,
} from "@hobbots/domain";
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
  /** What the hob is good at, for other hobs; empty for none. */
  readonly goodAt: string;
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
const OWN_KEYS = ["name", "lookSeed", "lookColor", "voice", "length", "goodAt", "visibleToHobs"] as const;
type OwnKey = (typeof OWN_KEYS)[number];

/**
 * Picks a starter role, which brings its title, sigil, hat and tool, or the user's own words
 * (`null`), which keep the title, sigil, hat and tool the hob has until the user changes them.
 * Good at follows a starter role only while it still holds the old role's note word for word, since
 * then it was never the user's own (ADR 032).
 */
export const pickRole = <D extends RoleChoice & { readonly goodAt: string }>(draft: D, role: RoleId | null): D => {
  if (role === null) return { ...draft, role: null };
  const refill = draft.role !== null && draft.goodAt.trim() === starterRole(draft.role).note;
  return { ...draft, ...roleFields(role), ...(refill && { goodAt: starterRole(role).note }) };
};

/** Why the role cannot be saved as it is, or undefined when it can. */
export const roleProblem = (draft: RoleChoice): string | undefined =>
  draft.roleTitle.trim() === "" ? "Give the role a title." : undefined;

/** The API's limit on a hob's name. */
export const NAME_MAX = 40;

/** Why the draft cannot be saved as it is, or undefined when it can. */
export const draftProblem = (draft: ProfileDraft): string | undefined => {
  if (draft.name.trim() === "") return "Give the hob a name.";
  if ((normalizeGoodAt(draft.goodAt) ?? "").length > GOOD_AT_MAX) return `Keep good at to ${GOOD_AT_MAX} characters.`;
  return roleProblem(draft);
};

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
    goodAt: hob.goodAt ?? "",
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

// What other hobs see of the hob that the draft changes: its good at, as one line, and whether they see it.
const directoryEdit = (hob: Agent, draft: ProfileDraft): UpdateAgentPayload => {
  const goodAt = normalizeGoodAt(draft.goodAt);
  return {
    ...(goodAt !== hob.goodAt && { goodAt }),
    ...(draft.visibleToHobs !== hob.visibleToHobs && { visibleToHobs: draft.visibleToHobs }),
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
    ...directoryEdit(hob, draft),
    ...(draft.voice !== hob.voice && { voice: draft.voice }),
    ...(draft.length !== hob.length && { length: draft.length }),
    ...(draft.instructions !== hob.instructions && { instructions: draft.instructions }),
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
    goodAt: keep("goodAt"),
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

/**
 * Who summoned the hob (ADR 034): you, a hob by its name, a hob that is no longer kept, or not known
 * yet while the hobs that could have summoned it are still being read.
 */
export type Summoner =
  | { readonly kind: "you" }
  | { readonly kind: "hob"; readonly name: string }
  | { readonly kind: "gone" }
  | { readonly kind: "unknown" };

/**
 * Who summoned the hob, looked up among `hobs`. A summoner missing from them is gone only once
 * `complete` says every hob it could be was read.
 */
export const summonerOf = (
  hob: Pick<Agent, "summonedBy">,
  hobs: ReadonlyArray<Pick<Agent, "id" | "name">>,
  complete: boolean,
): Summoner => {
  if (hob.summonedBy === null) return { kind: "you" };
  const found = hobs.find((other) => other.id === hob.summonedBy);
  if (found !== undefined) return { kind: "hob", name: found.name };
  return complete ? { kind: "gone" } : { kind: "unknown" };
};

/**
 * A way to retire (#408): at once, letting running replies finish or stopping them, or, for a hob
 * with open Tasks, stopping and handing them over, or finishing them first.
 */
export type RetireChoice = RetireWork | RetireOpenWork;

/**
 * The ways Retire offers, in the order shown. With no open Task, only what happens to running
 * replies; with open Tasks, finishing them first (unless the hob already is), handing them over,
 * or stopping, which fails them.
 */
export const retireChoices = (openTasks: number, retiring: boolean): ReadonlyArray<RetireChoice> => {
  if (openTasks === 0) return ["finish", "stop"];
  return retiring ? ["hand-over", "stop"] : ["finish-first", "hand-over", "stop"];
};

/** What Retire sends for the choice, or null for a hand-over with no hob picked yet. */
export const retirePayload = (choice: RetireChoice, handOverTo: AgentId | null): RetireAgentPayload | null => {
  if (choice === "hand-over") return handOverTo === null ? null : { openWork: "hand-over", handOverTo };
  return choice === "finish-first" ? { openWork: "finish-first" } : { activeWork: choice };
};

/** Each way to retire as a row: what it is, and what it does with the hob's work. */
export const retireChoiceCopy = (
  choice: RetireChoice,
  name: string,
  hasOpenTasks: boolean,
): { readonly title: string; readonly note: string } => {
  switch (choice) {
    case "finish":
      return {
        title: `Let ${name} finish what it is doing`,
        note: `Replies already running finish. ${name} starts nothing new.`,
      };
    case "finish-first":
      return {
        title: `Let ${name} finish its Tasks first`,
        note: `${name} takes no new work, keeps working its open Tasks, and retires when the last one ends.`,
      };
    case "hand-over":
      return {
        title: `Stop ${name} and hand its Tasks over`,
        note: "Running replies stop. Each open Task goes to the hob you pick and starts afresh there, its history kept.",
      };
    case "stop":
      return {
        title: `Stop ${name}'s work now`,
        note: hasOpenTasks
          ? "Running replies stop and its open Tasks fail. Their leads hear of it."
          : "Running replies stop where they are. What they wrote so far is kept.",
      };
  }
};

/** Why a Task cannot go to `taker`, in words, from Reassign's reason. */
export const handOverBlockText = (block: HandOverBlock, taker: string): string => {
  switch (block.reason) {
    case "lineage-owner":
      return `${taker} already works on the Task above this one.`;
    case "not-delegated":
      return "You asked for this Task in its chat, so it stays with its hob.";
    case "children-open":
      return "Work is still open under it.";
    case "quest-exists":
      return "It leads a Quest of its own.";
    default:
      return block.message;
  }
};

/** What Retire did, said once it is done. `taker` is the hob that took the open Tasks, for a hand-over. */
export const retiredSummary = (
  name: string,
  choice: RetireChoice,
  busy: boolean,
  taker: string | null = null,
): string => {
  if (choice === "finish-first")
    return `${name} finishes its open Tasks, then retires. It takes no new work meanwhile.`;
  if (choice === "hand-over") return `${name}'s open Tasks went to ${taker ?? "another hob"}. Its threads are kept.`;
  if (!busy) return `${name} is asleep. Its threads are kept and stay readable.`;
  return choice === "finish"
    ? `${name} finishes the replies it was writing, then sleeps. Its threads are kept.`
    : `${name}'s running replies were stopped. Its threads are kept.`;
};

import type { CreateAgentPayload } from "@hobbots/api";
import type { RuntimeHealth } from "@hobbots/domain";
import {
  type CraftKind,
  type FirstHobDraft,
  firstHobPayload,
  newDraft,
  pickCraft,
  type Random,
  rollName,
} from "./first-hob.ts";
import { runtimeProblem } from "./runtime-health.ts";

/**
 * A hob summoned after onboarding: the first hob's draft plus the chores the user describes in
 * their own words, which Hobbots folds into the hob's instructions.
 */
export interface SummonDraft extends FirstHobDraft {
  readonly chores: string;
  /** Whether the user typed the chores, so picking another kind keeps them. */
  readonly choresEdited: boolean;
}

/** Long enough for a few paragraphs of chores, well inside the API's instructions limit. */
export const CHORES_MAX = 4000;

/** What a hob of each kind might do, as a starting point the user edits. */
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

/** A fresh Summon draft, named so it does not share a name with a hob the user already has. */
export const newSummonDraft = (
  taken: ReadonlyArray<string>,
  random: Random = Math.random,
  makeId?: () => string,
): SummonDraft => {
  const base = makeId ? newDraft(random, makeId) : newDraft(random);
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  let name = base.name;
  // The dice never repeat the current name, so a few rolls find a free one when one exists.
  for (let tries = 0; used.has(name.toLowerCase()) && tries < 20; tries++) name = rollName(name, random);
  return { ...base, name, chores: sampleChores(base.kind), choresEdited: false };
};

/** Picking a kind brings its usual name and sample chores, unless the user wrote their own. */
export const pickKind = (draft: SummonDraft, kind: CraftKind): SummonDraft => {
  const picked = pickCraft(draft, kind);
  return draft.choresEdited ? picked : { ...picked, chores: sampleChores(kind) };
};

/** The create request: the first hob's request, with the chores added to the instructions. */
export const summonPayload = (draft: SummonDraft): CreateAgentPayload => {
  const payload = firstHobPayload(draft);
  const chores = draft.chores.trim();
  return chores
    ? { ...payload, instructions: `${payload.instructions}\n\nYour chores, in the user's words:\n${chores}` }
    : payload;
};

const NOT_READY: Readonly<Record<NonNullable<ReturnType<typeof runtimeProblem>>, string>> = {
  notFound: "Claude Code was not found on this computer.",
  notStarted: "Claude Code is installed but did not start.",
  outdated: "This Claude Code is older than Hobbots supports. Update it with claude update.",
  signedOut: "Claude Code is not signed in. Run claude in a terminal and sign in.",
};

/**
 * Why Claude cannot think for a new hob yet, or undefined when it is ready. Claude Code may still
 * list models when it is signed out or outdated, but only a ready provider can run the first chat.
 */
export const providerNotice = (health: RuntimeHealth | undefined): string | undefined => {
  if (health === undefined) return "Claude Code is not connected.";
  if (health.availability === "ready") return undefined;
  const problem = runtimeProblem(health);
  return problem ? NOT_READY[problem] : "Hobbots could not confirm Claude Code is ready yet.";
};

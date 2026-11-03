import { RUNTIME_NAMES, type RuntimeHealth } from "@hobbots/domain";
import { draftProblem, type FirstHobDraft, newDraft, type Random, restoreDraft, rollName } from "./first-hob.ts";

/**
 * A fresh Summon draft, named so it does not share a name with a hob the user already has. A
 * summon is the same draft as the first hob's; only the checks around it differ.
 */
export const newSummonDraft = (
  taken: ReadonlyArray<string>,
  random: Random = Math.random,
  makeId?: () => string,
): FirstHobDraft => {
  const base = makeId ? newDraft(random, makeId) : newDraft(random);
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  let name = base.name;
  // The dice never repeat the current name, so a few rolls find a free one when one exists.
  for (let tries = 0; used.has(name.toLowerCase()) && tries < 20; tries++) name = rollName(name, random);
  return { ...base, name };
};

/**
 * The draft Summon opens with: the one the user left, unless its hob already joined the list,
 * else a fresh one.
 */
export const openSummonDraft = (
  kept: Partial<FirstHobDraft> | null,
  hobs: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  random: Random = Math.random,
): FirstHobDraft => {
  if (kept !== null && !hobs.some((hob) => hob.id === kept.id)) return restoreDraft(kept, random);
  return newSummonDraft(
    hobs.map((hob) => hob.name),
    random,
  );
};

/** The provider's health as the form knows it: still being checked, failed to check, or checked. */
export interface ProviderCheck {
  readonly pending: boolean;
  readonly failed: boolean;
  /** The health of the provider the draft thinks with. */
  readonly health: RuntimeHealth | undefined;
}

/**
 * What stops a new summon, or undefined when it can go. A hob needs its provider confirmed ready, so
 * an unknown health stops it too, and a provider that cannot think now cannot be picked. Retrying a
 * summon already sent is never stopped: the hub may have made that hob already, and the retry only
 * asks for it again.
 */
export const summonProblem = (
  draft: FirstHobDraft,
  provider: ProviderCheck,
  modelFound: boolean,
): string | undefined => {
  if (draft.submitted !== null) return undefined;
  const name = draft.name.trim() || "your hob";
  const problem = draftProblem(draft);
  if (problem) return problem;
  if (provider.health === undefined && provider.pending) return "Checking your AI providers";
  if (provider.health === undefined && provider.failed) return `Check your AI providers again to summon ${name}`;
  if (provider.health?.availability !== "ready") return `Fix a provider to summon ${name}`;
  return modelFound ? undefined : `Waiting for ${RUNTIME_NAMES[draft.runtime]}'s models`;
};

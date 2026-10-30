import type { RuntimeHealth } from "@hobbots/domain";
import { draftProblem, type FirstHobDraft, newDraft, type Random, restoreDraft, rollName } from "./first-hob.ts";
import { runtimeProblem } from "./runtime-health.ts";

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

/** Claude Code's health as the form knows it: still being checked, failed to check, or checked. */
export interface ProviderCheck {
  readonly pending: boolean;
  readonly failed: boolean;
  readonly health: RuntimeHealth | undefined;
}

/**
 * What stops a new summon, or undefined when it can go. A hob needs a provider confirmed ready, so
 * an unknown health stops it too. Retrying a summon already sent is never stopped: the hub may have
 * made that hob already, and the retry only asks for it again.
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
  if (provider.health === undefined && provider.pending) return "Checking Claude Code";
  if (provider.health === undefined && provider.failed) return `Check Claude Code again to summon ${name}`;
  if (providerNotice(provider.health)) return `Fix Claude Code in Settings to summon ${name}`;
  return modelFound ? undefined : "Waiting for Claude Code's models";
};

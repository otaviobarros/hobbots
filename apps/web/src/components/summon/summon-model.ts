import { ROLE_HAT_TITLES, ROLE_TOOL_TITLES, starterRole } from "@hobbots/domain";
import { type FirstHobDraft, nearbySeeds, pickRole } from "../../api/first-hob.ts";
import { messages } from "./messages.ts";

/**
 * Summon's steps and the decisions around them, kept apart from the screens so they can be tested
 * without a browser (STD-REACT-009).
 */

const SUMMON_STEPS = ["role", "look", "ready"] as const;
export type SummonStep = (typeof SUMMON_STEPS)[number];

/** The step an address names, or the first one when it names none or an unknown one. */
export const parseStep = (value: unknown): SummonStep => SUMMON_STEPS.find((step) => step === value) ?? SUMMON_STEPS[0];

export const stepIndex = (step: SummonStep): number => SUMMON_STEPS.indexOf(step);

/** The step at an index, kept inside the list. */
export const stepAt = (index: number): SummonStep =>
  SUMMON_STEPS[Math.min(Math.max(index, 0), SUMMON_STEPS.length - 1)] as SummonStep;

/** Why the role step cannot move on yet, or undefined when it can. */
export const roleProblem = (draft: FirstHobDraft): string | undefined =>
  draft.role === null && draft.ownTitle.trim() === "" ? "Give your hob's role a title" : undefined;

/**
 * Typing a title of the user's own makes it the hob's role: the starter role is dropped, so the hat
 * and tool go back to the look. Emptying the field keeps the title empty until a role is picked.
 */
export const typeOwnTitle = (draft: FirstHobDraft, ownTitle: string): FirstHobDraft => ({
  ...(draft.role === null ? draft : pickRole(draft, null)),
  ownTitle,
});

/** The five looks the Look step offers: the current set's own look first, then four near it. */
export const lookChoices = (draft: FirstHobDraft): ReadonlyArray<number> => [
  draft.lookBase,
  ...nearbySeeds(draft.lookBase).slice(0, 4),
];

/** The line under the hat and tool, which says where they came from. */
export const gearHint = (draft: FirstHobDraft): string => {
  if (draft.role === null) return messages.look.gearOwn;
  const role = starterRole(draft.role);
  return messages.look.gearFromRole({
    role: role.title,
    hat: ROLE_HAT_TITLES[role.hat].toLowerCase(),
    tool: ROLE_TOOL_TITLES[role.tool].toLowerCase(),
    emptyHanded: role.tool === "none",
  });
};

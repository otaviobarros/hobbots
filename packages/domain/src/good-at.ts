import { type RoleId, starterRole } from "./roles.ts";

/**
 * What a hob is good at: one public line that other hobs read to know when to come to it (ADR 032).
 * It never changes how the hob itself behaves, so it is never part of the hob's own prompt.
 */

/** The longest good at the hub stores. A longer value is refused when it is saved, never cut. */
export const GOOD_AT_MAX = 200;

/** The line Summon and onboarding put above the chores they fold into a hob's instructions. */
export const CHORES_HEADING = "Your chores, in the user's words:\n";

/** The instructions Summon and onboarding give a new hob: its chores under their heading, or nothing. */
export const choresInstructions = (chores: string): string => {
  const trimmed = chores.trim();
  return trimmed === "" ? "" : `${CHORES_HEADING}${trimmed}`;
};

/** Good at as it is stored: trimmed, every run of whitespace one space, and null when empty. */
export const normalizeGoodAt = (text: string | null): string | null => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line === "" ? null : line;
};

// One character, so a shortened line keeps as much of its words as it can.
const ELLIPSIS = "…";

/** A line of good at that fits the limit: shortened at the last word that fits, with an ellipsis. */
const fitGoodAt = (line: string): string => {
  if (line.length <= GOOD_AT_MAX) return line;
  const room = line.slice(0, GOOD_AT_MAX - ELLIPSIS.length + 1);
  const lastSpace = room.lastIndexOf(" ");
  const kept = (lastSpace > 0 ? room.slice(0, lastSpace) : room.slice(0, GOOD_AT_MAX - ELLIPSIS.length)).trimEnd();
  return `${kept}${ELLIPSIS}`;
};

/**
 * The good at a hob starts with: the chores you gave it in one line, or else its starter role's
 * note, or else nothing for a title in your own words with no chores. Summon fills the field with
 * it, and the hub with the same words for a hob whose request leaves good at out.
 */
export const goodAtPrefill = (chores: string, role: RoleId | null): string | null => {
  const line = normalizeGoodAt(chores) ?? (role === null ? null : starterRole(role).note);
  return line === null ? null : fitGoodAt(line);
};

/** The chores Summon or onboarding folded into instructions, or nothing when they hold none. */
export const choresIn = (instructions: string): string => {
  const at = instructions.lastIndexOf(CHORES_HEADING);
  return at === -1 ? "" : instructions.slice(at + CHORES_HEADING.length);
};

/**
 * The good at the profile showed before it was stored (ADR 032): the prefill of the chores in the
 * instructions and the starter role. Only for a hob or a version that has no stored good at yet.
 */
export const goodAtFromInstructions = (hob: { readonly instructions: string; readonly role: RoleId | null }) =>
  goodAtPrefill(choresIn(hob.instructions), hob.role);

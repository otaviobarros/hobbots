import type { SkillChange } from "@hobbots/api";
import { skillRevisionLabel } from "@hobbots/domain";
import { formatList } from "../../lib/format.ts";
import { formatDay } from "../../lib/time.ts";
import { messages } from "./messages.ts";
import { type HobDirectory, scopeName, skillTitle } from "./skills-model.ts";

const copy = messages.changes;

const DAY = 24 * 60 * 60 * 1000;

/** The day a change is listed under: Today, Yesterday, or its date. */
export const changeDay = (iso: string, now: Date): string => {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = Date.parse(iso);
  if (at >= startOfToday) return copy.today;
  if (at >= startOfToday - DAY) return copy.yesterday;
  return formatDay(iso, now);
};

/** The changes grouped by day, newest first, as What changed lists them. */
export const changesByDay = (changes: ReadonlyArray<SkillChange>, now: Date) => {
  const days: Array<{ day: string; changes: Array<SkillChange> }> = [];
  for (const change of changes) {
    const day = changeDay(change.at, now);
    const last = days.at(-1);
    if (last?.day === day) last.changes.push(change);
    else days.push({ day, changes: [change] });
  }
  return days;
};

const rev = (number: number | null) => (number === null ? copy.aRevision : skillRevisionLabel({ number }));

/** Who did it, as the line above a change says it. */
const byOf = (change: SkillChange, hobs: HobDirectory) => {
  switch (change.by?._tag) {
    case "Hob":
      return copy.byHob({ name: hobs.get(change.by.agentId)?.name ?? messages.scopes.formerHob });
    case "Source":
      return copy.bySource;
    default:
      return copy.byYou;
  }
};

/** A change's kind line, its sentence, and the note under it. */
export const changeText = (change: SkillChange, hobs: HobDirectory) => {
  const name = skillTitle(change.name);
  const who = formatList(change.scopes.map((scope) => scopeName(scope, hobs)));
  const hob = change.agentId === null ? "" : (hobs.get(change.agentId)?.name ?? messages.scopes.formerHob);
  switch (change.kind) {
    case "saved":
      return {
        kind: copy.saved({ by: byOf(change, hobs) }),
        line: copy.savedLine({ name, rev: rev(change.number), count: change.scopes.length }),
        note:
          change.held.length === 0
            ? null
            : copy.heldNote({ who: formatList(change.held.map((scope) => scopeName(scope, hobs))) }),
      };
    case "rolledOut": {
      const back = change.previousNumber !== null && change.number !== null && change.previousNumber > change.number;
      return {
        kind: back ? copy.rolledBack : copy.rolledOut,
        line: copy.movedLine({ name, from: rev(change.previousNumber), to: rev(change.number), who }),
        note: null,
      };
    }
    case "assigned":
      return { kind: copy.assigned, line: copy.assignedLine({ name, rev: rev(change.number), who }), note: null };
    case "unassigned":
      return { kind: copy.unassigned, line: copy.unassignedLine({ name, who }), note: null };
    case "held":
      return { kind: copy.held, line: copy.heldLine({ name, rev: rev(change.number), who }), note: null };
    case "followed":
      return { kind: copy.followed, line: copy.followedLine({ name, who }), note: null };
    case "optedOut":
      return { kind: copy.optedOut, line: copy.optedOutLine({ name, hob }), note: null };
    case "optedIn":
      return { kind: copy.optedIn, line: copy.optedInLine({ name, hob }), note: null };
    case "removed":
      return { kind: copy.removed, line: copy.removedLine({ name }), note: null };
  }
};

/** Whether Roll back can move a save's or a rollout's places back to where they were. */
export const canRollBack = (change: SkillChange): boolean =>
  (change.kind === "saved" || change.kind === "rolledOut") && change.previous !== null && change.moved.length > 0;

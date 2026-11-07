import type { SkillChange } from "@hobbots/api";
import type {
  EventEnvelope,
  JournaledEvent,
  SkillAssignment,
  SkillId,
  SkillName,
  SkillRevisionHash,
} from "@hobbots/domain";

/** The journal's skill changes What changed reads: every library change but a use. */
export const SKILL_CHANGE_TYPES = [
  "SkillRevisionAdded",
  "SkillAssigned",
  "SkillUnassigned",
  "SkillRolledOut",
  "SkillHeld",
  "SkillOptOutChanged",
  "SkillRemoved",
] as const;

/** How long after a save its rollout and holds still read as part of it, and a rollout's moves as one. */
const SAME_CHANGE_MS = 60_000;

/** What the changes need from the library: a skill's name and the number of each of its revisions. */
export interface SkillChangeLookup {
  readonly name: (skillId: SkillId) => SkillName | null;
  readonly number: (skillId: SkillId, hash: SkillRevisionHash) => number | null;
  /** The revision before `number`, which Roll back from a save goes to. */
  readonly before: (skillId: SkillId, number: number) => SkillRevisionHash | null;
}

type Draft = { -readonly [K in keyof SkillChange]: SkillChange[K] } & {
  readonly pin: SkillRevisionHash | null;
  readonly ms: number;
};

const blank = (at: string, skillId: SkillId, name: SkillName) => ({
  at,
  ms: Date.parse(at),
  skillId,
  name,
  number: null,
  scopes: [],
  held: [],
  moved: [],
  previous: null,
  previousNumber: null,
  agentId: null,
  by: null,
  pin: null,
});

const near = (draft: Draft | undefined, at: string): draft is Draft =>
  draft !== undefined && Date.parse(at) - draft.ms <= SAME_CHANGE_MS;

/**
 * The journal's skill entries as What changed lists them (ADR 029, The Skills page), newest first.
 * A save's rollout and the holds it set read as part of the save, and a rollout's moves of one skill
 * to one revision as one change. `envelopes` come in any order; at most `limit` changes are kept.
 */
export const skillChangesOf = (
  envelopes: ReadonlyArray<EventEnvelope>,
  lookup: SkillChangeLookup,
  limit: number,
): ReadonlyArray<SkillChange> => {
  const changes: Array<Draft> = [];
  // The latest change of each skill, which a rollout or a hold that follows it may join.
  const last = new Map<SkillId, Draft>();
  // A skill removed since keeps the name its last revision or its removal gave it.
  const removed = new Map<SkillId, SkillName>();
  for (const { payload } of envelopes) {
    if (payload._tag === "SkillRevisionAdded") removed.set(payload.skill.id, payload.skill.name);
    if (payload._tag === "SkillRemoved") removed.set(payload.skill.id, payload.skill.name);
  }
  const nameOf = (skillId: SkillId) => lookup.name(skillId) ?? removed.get(skillId) ?? null;
  const push = (draft: Draft) => {
    changes.push(draft);
    last.set(draft.skillId, draft);
  };
  const ofAssignment = (kind: SkillChange["kind"], assignment: SkillAssignment, at: string) => {
    const name = nameOf(assignment.skillId);
    if (name === null) return;
    push({
      ...blank(at, assignment.skillId, name),
      kind,
      number: lookup.number(assignment.skillId, assignment.pin),
      scopes: [assignment.scope],
      by: assignment.by,
    });
  };

  for (const envelope of [...envelopes].sort((a, b) => a.sequence - b.sequence)) {
    const event: JournaledEvent = envelope.payload;
    const at = envelope.occurredAt;
    switch (event._tag) {
      case "SkillRevisionAdded": {
        const { skill, revision } = event;
        const previous = lookup.before(skill.id, revision.number);
        push({
          ...blank(at, skill.id, skill.name),
          kind: "saved",
          number: revision.number,
          pin: revision.hash,
          previous,
          previousNumber: previous === null ? null : revision.number - 1,
          by: revision.addedBy,
        });
        break;
      }
      case "SkillRolledOut": {
        const { assignment, from } = event;
        const before = last.get(assignment.skillId);
        const joins =
          near(before, at) &&
          before.pin === assignment.pin &&
          (before.kind === "saved" || (before.kind === "rolledOut" && before.previous === from));
        if (joins) {
          before.scopes = [...before.scopes, assignment.scope];
          before.moved = [...before.moved, assignment.id];
          break;
        }
        const name = nameOf(assignment.skillId);
        if (name === null) break;
        push({
          ...blank(at, assignment.skillId, name),
          kind: "rolledOut",
          number: lookup.number(assignment.skillId, assignment.pin),
          pin: assignment.pin,
          scopes: [assignment.scope],
          moved: [assignment.id],
          previous: from,
          previousNumber: lookup.number(assignment.skillId, from),
          by: assignment.by,
        });
        break;
      }
      case "SkillHeld": {
        const { assignment } = event;
        const before = last.get(assignment.skillId);
        // A save holds the places you switched off before its rollout moves the rest.
        if (assignment.held && near(before, at) && before.kind === "saved" && before.moved.length === 0) {
          before.held = [...before.held, assignment.scope];
          break;
        }
        ofAssignment(assignment.held ? "held" : "followed", assignment, at);
        break;
      }
      case "SkillAssigned":
        ofAssignment("assigned", event.assignment, at);
        break;
      case "SkillUnassigned":
        ofAssignment("unassigned", event.assignment, at);
        break;
      case "SkillOptOutChanged": {
        const name = nameOf(event.optOut.skillId);
        if (name === null) break;
        push({
          ...blank(at, event.optOut.skillId, name),
          kind: event.optedOut ? "optedOut" : "optedIn",
          agentId: event.optOut.agentId,
        });
        break;
      }
      case "SkillRemoved":
        push({ ...blank(at, event.skill.id, event.skill.name), kind: "removed" });
        break;
      default:
        break;
    }
  }
  return changes
    .reverse()
    .slice(0, limit)
    .map(({ pin: _pin, ms: _ms, ...change }) => change);
};

/** The skill a journaled skill change is about. */
export const skillIdOfChange = (event: JournaledEvent): SkillId | null => {
  switch (event._tag) {
    case "SkillRevisionAdded":
    case "SkillRemoved":
      return event.skill.id;
    case "SkillAssigned":
    case "SkillUnassigned":
    case "SkillRolledOut":
    case "SkillHeld":
      return event.assignment.skillId;
    case "SkillOptOutChanged":
      return event.optOut.skillId;
    default:
      return null;
  }
};

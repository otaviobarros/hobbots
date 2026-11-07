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
  member: null,
  by: null,
  pin: null,
});

const near = (draft: Draft | undefined, at: string): draft is Draft =>
  draft !== undefined && Date.parse(at) - draft.ms <= SAME_CHANGE_MS;

/** The changes so far, and the latest of each skill, which a rollout or a hold that follows it may join. */
interface Changes {
  readonly lookup: SkillChangeLookup;
  readonly nameOf: (skillId: SkillId) => SkillName | null;
  readonly list: Array<Draft>;
  readonly last: Map<SkillId, Draft>;
}

const push = (changes: Changes, draft: Draft) => {
  changes.list.push(draft);
  changes.last.set(draft.skillId, draft);
};

const ofAssignment = (changes: Changes, kind: SkillChange["kind"], assignment: SkillAssignment, at: string) => {
  const name = changes.nameOf(assignment.skillId);
  if (name === null) return;
  push(changes, {
    ...blank(at, assignment.skillId, name),
    kind,
    number: changes.lookup.number(assignment.skillId, assignment.pin),
    scopes: [assignment.scope],
    by: assignment.by,
  });
};

const saved = (changes: Changes, event: Extract<JournaledEvent, { _tag: "SkillRevisionAdded" }>, at: string) => {
  const { skill, revision } = event;
  push(changes, {
    ...blank(at, skill.id, skill.name),
    kind: "saved",
    number: revision.number,
    pin: revision.hash,
    by: revision.addedBy,
  });
};

const rolledOut = (changes: Changes, event: Extract<JournaledEvent, { _tag: "SkillRolledOut" }>, at: string) => {
  const { assignment, from } = event;
  const before = changes.last.get(assignment.skillId);
  const joins =
    near(before, at) &&
    before.pin === assignment.pin &&
    (before.kind === "saved" || (before.kind === "rolledOut" && before.moved.every((one) => one.from === from)));
  if (joins) {
    before.scopes = [...before.scopes, assignment.scope];
    before.moved = [...before.moved, { assignmentId: assignment.id, from }];
    return;
  }
  const name = changes.nameOf(assignment.skillId);
  if (name === null) return;
  push(changes, {
    ...blank(at, assignment.skillId, name),
    kind: "rolledOut",
    number: changes.lookup.number(assignment.skillId, assignment.pin),
    pin: assignment.pin,
    scopes: [assignment.scope],
    moved: [{ assignmentId: assignment.id, from }],
    by: assignment.by,
  });
};

const held = (changes: Changes, assignment: SkillAssignment, at: string) => {
  const before = changes.last.get(assignment.skillId);
  // A save holds the places you switched off before its rollout moves the rest.
  if (assignment.held && near(before, at) && before.kind === "saved" && before.moved.length === 0) {
    before.held = [...before.held, assignment.scope];
    return;
  }
  ofAssignment(changes, assignment.held ? "held" : "followed", assignment, at);
};

const optedOut = (changes: Changes, event: Extract<JournaledEvent, { _tag: "SkillOptOutChanged" }>, at: string) => {
  const name = changes.nameOf(event.optOut.skillId);
  if (name === null) return;
  push(changes, {
    ...blank(at, event.optOut.skillId, name),
    kind: event.optedOut ? "optedOut" : "optedIn",
    agentId: event.optOut.agentId,
    member: event.optOut.member,
  });
};

const add = (changes: Changes, event: JournaledEvent, at: string) => {
  switch (event._tag) {
    case "SkillRevisionAdded":
      return saved(changes, event, at);
    case "SkillRolledOut":
      return rolledOut(changes, event, at);
    case "SkillHeld":
      return held(changes, event.assignment, at);
    case "SkillAssigned":
      return ofAssignment(changes, "assigned", event.assignment, at);
    case "SkillUnassigned":
      return ofAssignment(changes, "unassigned", event.assignment, at);
    case "SkillOptOutChanged":
      return optedOut(changes, event, at);
    case "SkillRemoved":
      return push(changes, { ...blank(at, event.skill.id, event.skill.name), kind: "removed" });
    default:
      return;
  }
};

/**
 * Where the places a save or rollout moved came from: one revision when they were all on it, which
 * the line names, or none when they were on different ones. Roll back takes each to its own.
 */
const withPrevious = (change: SkillChange, lookup: SkillChangeLookup): SkillChange => {
  const froms = new Set(change.moved.map((one) => one.from));
  const [only] = froms;
  if (froms.size !== 1 || only === undefined) return change;
  return { ...change, previous: only, previousNumber: lookup.number(change.skillId, only) };
};

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
  // A skill removed since keeps the name its last revision or its removal gave it.
  const removed = new Map<SkillId, SkillName>();
  for (const { payload } of envelopes) {
    if (payload._tag === "SkillRevisionAdded" || payload._tag === "SkillRemoved") {
      removed.set(payload.skill.id, payload.skill.name);
    }
  }
  const changes: Changes = {
    lookup,
    nameOf: (skillId) => lookup.name(skillId) ?? removed.get(skillId) ?? null,
    list: [],
    last: new Map(),
  };
  for (const envelope of [...envelopes].sort((a, b) => a.sequence - b.sequence)) {
    add(changes, envelope.payload, envelope.occurredAt);
  }
  return changes.list
    .reverse()
    .slice(0, limit)
    .map(({ pin: _pin, ms: _ms, ...change }) => withPrevious(change, lookup));
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

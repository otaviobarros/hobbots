import type { HobSkill, HobSkills, SkillsList } from "@hobbots/api";
import {
  type AgentId,
  type MemoryProjectIdentity,
  memoryScopeKey,
  type Skill,
  type SkillAssignment,
  type SkillId,
  type SkillScope,
} from "@hobbots/domain";

/**
 * Why a skill a hob would get does not load, or loads with a note: it is turned off for the hob, a
 * narrower scope's skill of the same name replaces it, or two projects define its name.
 */
type CarriedState =
  | { readonly _tag: "Loads" }
  | { readonly _tag: "Off" }
  | { readonly _tag: "Replaced"; readonly by: SkillScope }
  | { readonly _tag: "Clash" };

/** One skill a hob gets from a scope, as its Skills list shows it. */
export interface CarriedRow {
  readonly skill: Skill;
  readonly scope: SkillScope;
  readonly assignment: SkillAssignment | null;
  /** The revision it loads, or null when it is pinned to an older one than the newest. */
  readonly number: number | null;
  /** The newest revision's number, when the pin is an older one, as "r5 available". */
  readonly newer: number | null;
  readonly held: boolean;
  readonly onlyWhenAsked: boolean;
  /** The Charms it names that the hob does not have. */
  readonly missingCharms: ReadonlyArray<string>;
  readonly state: CarriedState;
  /**
   * For a skill of a set (ADR 029, Skill sets), the one of its skills this row is; null for a skill,
   * or for a whole set the hob turned off.
   */
  readonly member: { readonly name: string; readonly description: string } | null;
}

/** A scope a hob gets skills from: Everyone, each project it works in, and its own. */
export interface CarriedGroup {
  readonly key: string;
  readonly scope: SkillScope;
  readonly rows: ReadonlyArray<CarriedRow>;
}

const LOADS: CarriedState = { _tag: "Loads" };

const nameOf = (row: CarriedRow) => row.member?.name ?? row.skill.name;
const byName = (a: CarriedRow, b: CarriedRow) => nameOf(a).localeCompare(nameOf(b));

type Members = ReadonlyMap<SkillId, ReadonlyArray<{ readonly name: string; readonly description: string }>>;

/** A set's skill by its name, or null for a skill that is no set (ADR 029, Skill sets). */
const memberOf = (members: Members, skillId: SkillId, name: string): CarriedRow["member"] => {
  const set = members.get(skillId);
  if (set === undefined) return null;
  return set.find((one) => one.name === name) ?? { name, description: "" };
};

/** The assignment a hob skill comes from: the library's assignment of that skill to that scope. */
const assignmentOf = (assignments: ReadonlyArray<SkillAssignment>, skillId: SkillId, scope: SkillScope) => {
  const key = memoryScopeKey(scope);
  return assignments.find((one) => one.skillId === skillId && memoryScopeKey(one.scope) === key) ?? null;
};

const rowOf = (
  skill: Skill,
  scope: SkillScope,
  assignment: SkillAssignment | null,
  pin: string,
  extra: {
    onlyWhenAsked: boolean;
    missingCharms: ReadonlyArray<string>;
    state: CarriedState;
    member: CarriedRow["member"];
  },
): CarriedRow => {
  const latest = pin === skill.latest;
  return {
    skill,
    scope,
    assignment,
    number: latest ? skill.revisions : null,
    newer: latest ? null : skill.revisions,
    held: assignment?.held ?? false,
    ...extra,
  };
};

/**
 * What a hob carries, by where it comes from (ADR 029, Scopes): Everyone, each project it works in,
 * then its own. Each group lists the skills it loads, those turned off for the hob, those a narrower
 * scope replaced, and names two projects both define, which load from neither.
 */
export const carriedGroups = (hob: HobSkills, list: SkillsList): ReadonlyArray<CarriedGroup> => {
  const skills = new Map(list.skills.map((skill) => [skill.id, skill]));
  const members: Members = new Map(list.sets.map((set) => [set.skillId, set.skills]));
  const own: SkillScope = { _tag: "Hob", agentId: hob.agentId };
  const scopes: ReadonlyArray<SkillScope> = [
    { _tag: "Everyone" },
    ...[...hob.projects].sort().map((identity): SkillScope => ({ _tag: "Project", identity })),
    own,
  ];
  const groups = new Map(scopes.map((scope) => [memoryScopeKey(scope), [] as Array<CarriedRow>]));
  const add = (row: CarriedRow) => groups.get(memoryScopeKey(row.scope))?.push(row);

  for (const one of hob.skills) {
    const skill = skills.get(one.skillId);
    if (skill === undefined) continue;
    const assignment = assignmentOf(list.assignments, one.skillId, one.scope);
    add(
      rowOf(skill, one.scope, assignment, one.pin, {
        ...one,
        state: LOADS,
        member: memberOf(members, skill.id, one.name),
      }),
    );
  }
  for (const { assignment, by, name } of hob.replaced) {
    const skill = skills.get(assignment.skillId);
    if (skill === undefined) continue;
    add(
      rowOf(
        skill,
        assignment.scope,
        assignment,
        assignment.pin,
        extraOf(assignment, { _tag: "Replaced", by: by.scope }, memberOf(members, skill.id, name)),
      ),
    );
  }
  for (const clash of hob.clashes) {
    for (const assignment of clash.assignments) {
      const skill = skills.get(assignment.skillId);
      if (skill === undefined) continue;
      const member = memberOf(members, skill.id, clash.name);
      add(rowOf(skill, assignment.scope, assignment, assignment.pin, extraOf(assignment, { _tag: "Clash" }, member)));
    }
  }
  for (const skillId of hob.optedOut) {
    const skill = skills.get(skillId);
    const assignment = sharedAssignment(list.assignments, skillId, hob.projects);
    if (skill === undefined || assignment === null) continue;
    add(rowOf(skill, assignment.scope, assignment, assignment.pin, extraOf(assignment, { _tag: "Off" }, null)));
  }
  for (const { skillId, name } of hob.optedOutOfSets) {
    const skill = skills.get(skillId);
    const assignment = sharedAssignment(list.assignments, skillId, hob.projects);
    if (skill === undefined || assignment === null) continue;
    const member = memberOf(members, skillId, name) ?? { name, description: "" };
    add(rowOf(skill, assignment.scope, assignment, assignment.pin, extraOf(assignment, { _tag: "Off" }, member)));
  }
  return scopes.map((scope) => {
    const key = memoryScopeKey(scope);
    return { key, scope, rows: [...(groups.get(key) ?? [])].sort(byName) };
  });
};

const extraOf = (assignment: SkillAssignment, state: CarriedState, member: CarriedRow["member"]) => ({
  onlyWhenAsked: assignment.onlyWhenAsked,
  missingCharms: [],
  state,
  member,
});

/** The shared assignment a hob turned off: Everyone's, else one of the projects it works in. */
const sharedAssignment = (
  assignments: ReadonlyArray<SkillAssignment>,
  skillId: SkillId,
  projects: ReadonlyArray<MemoryProjectIdentity>,
) =>
  assignments.find((one) => one.skillId === skillId && one.scope._tag === "Everyone") ??
  assignments.find(
    (one) => one.skillId === skillId && one.scope._tag === "Project" && projects.includes(one.scope.identity),
  ) ??
  null;

/** What the picker offers a hob: a library skill to give it, or a shared one it turned off, to turn on again. */
export type GiveOffer =
  | { readonly _tag: "Give"; readonly skill: Skill; readonly given: ReadonlyArray<SkillScope> }
  | { readonly _tag: "TurnOn"; readonly skill: Skill; readonly scope: SkillScope };

/**
 * The skills a hob can be given (ADR 029, A hob's Skills tab): every library skill it does not carry,
 * with where it is given now, and the shared skills it turned off. Skills it gets already, or that a
 * clash or a narrower scope keeps from loading, are left out; the list says why those do not load.
 */
export const giveOffers = (hob: HobSkills, list: SkillsList): ReadonlyArray<GiveOffer> => {
  const carried = new Set<SkillId>([
    ...hob.skills.map((one) => one.skillId),
    ...hob.replaced.map((one) => one.assignment.skillId),
    ...hob.clashes.flatMap((one) => one.assignments.map((assignment) => assignment.skillId)),
  ]);
  const off = new Set(hob.optedOut);
  const offers: Array<GiveOffer> = [];
  for (const skill of [...list.skills].sort((a, b) => a.name.localeCompare(b.name))) {
    if (off.has(skill.id)) {
      const assignment = sharedAssignment(list.assignments, skill.id, hob.projects);
      if (assignment !== null) offers.push({ _tag: "TurnOn", skill, scope: assignment.scope });
      continue;
    }
    if (carried.has(skill.id)) continue;
    const given = list.assignments.filter((one) => one.skillId === skill.id).map((one) => one.scope);
    offers.push({ _tag: "Give", skill, given });
  }
  return offers;
};

/** The skills Summon offers a hob that does not exist yet: every one Everyone does not give it already. */
export const summonOffers = (list: SkillsList): ReadonlyArray<GiveOffer> => {
  const everyone = new Set(list.assignments.filter((one) => one.scope._tag === "Everyone").map((one) => one.skillId));
  return [...list.skills]
    .filter((skill) => !everyone.has(skill.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      _tag: "Give" as const,
      skill,
      given: list.assignments.filter((one) => one.skillId === skill.id).map((one) => one.scope),
    }));
};

/** How many skills Everyone gives, which a new hob gets without being given them. */
export const everyoneCount = (list: SkillsList): number =>
  new Set(list.assignments.filter((one) => one.scope._tag === "Everyone").map((one) => one.skillId)).size;

/** The skills that need a Charm the hob lacks, as warnings above its list. */
export const charmWarnings = (hob: HobSkills): ReadonlyArray<HobSkill> =>
  hob.skills.filter((one) => one.missingCharms.length > 0);

/** The hob's own scope, where the picker gives a skill. */
export const ownScope = (agentId: AgentId): SkillScope => ({ _tag: "Hob", agentId });

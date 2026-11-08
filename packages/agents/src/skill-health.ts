import {
  SKILL_DESCRIPTION_LONG,
  SKILL_LISTING_BUDGET,
  SKILL_UNUSED_DAYS,
  type SkillHealth,
  type SkillLoad,
} from "@hobbots/api";
import {
  type AgentId,
  type RuntimeKind,
  type Skill,
  type SkillAssignment,
  type SkillId,
  type SkillName,
  type SkillRevision,
  skillMentionOf,
} from "@hobbots/domain";
import { Effect } from "effect";
import type { ResolvedSkills, SkillLibraryShape } from "./skills.ts";

/**
 * The Skills Overview's health checks (ADR 029, Health checks, #1099), as pure rules over what the
 * library holds and what each hob's next turn would get, so every runtime is judged alike.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Words that say when to use a skill, which a runtime picks it by (ADR 029, Picked on its own). */
const WHEN = /\b(when|whenever|before|if|while|after|asked|ask(?:s|ed)? for)\b/i;

/** A description shorter than this says too little to be picked on its own. */
const DESCRIPTION_SHORT = 40;

/**
 * Whether a description may keep its skill from being picked: it is short or names no request it is
 * for (`vague`), or it is long enough to crowd the listing (`long`); null when it reads well.
 */
export const descriptionProblem = (description: string): "vague" | "long" | null => {
  const text = description.trim();
  if (text.length > SKILL_DESCRIPTION_LONG) return "long";
  return text.length < DESCRIPTION_SHORT || !WHEN.test(text) ? "vague" : null;
};

/** One line of a runtime's listing: the skill's full name and its description. */
export const listingCharacters = (skill: {
  readonly name: string;
  readonly set: string | null;
  readonly description: string;
}): number => `${skillMentionOf(skill)}: ${skill.description}`.length;

/** A hob as the checks see it: its skills as its next turn would get them, with each one's description. */
export interface HealthHob {
  readonly agentId: AgentId;
  readonly runtime: RuntimeKind;
  readonly resolved: ResolvedSkills;
  /** The description of each skill it loads, by full name (`set:name` for a skill of a set). */
  readonly descriptions: ReadonlyMap<string, string>;
}

export interface HealthInput {
  readonly now: string;
  readonly skills: ReadonlyArray<Skill>;
  /** Each skill's newest revision. */
  readonly newest: ReadonlyMap<SkillId, SkillRevision>;
  readonly assignments: ReadonlyArray<SkillAssignment>;
  /** The number of each revision an assignment pins, by hash; a revision the library lost is missing. */
  readonly numbers: ReadonlyMap<string, number>;
  readonly lastUsedAt: ReadonlyArray<{ readonly skillId: SkillId; readonly at: string }>;
  readonly hobs: ReadonlyArray<HealthHob>;
}

const unusedOf = (input: HealthInput): SkillHealth["unused"] => {
  const cutoff = Date.parse(input.now) - SKILL_UNUSED_DAYS * DAY_MS;
  const last = new Map(input.lastUsedAt.map((one) => [one.skillId, one.at]));
  return input.skills.flatMap((skill) => {
    const assignments = input.assignments.filter((one) => one.skillId === skill.id).length;
    const at = last.get(skill.id) ?? null;
    // A skill nobody gets costs no hob anything, and one added lately has had no time to be used.
    if (assignments === 0 || Date.parse(at ?? skill.createdAt) > cutoff) return [];
    return [{ skillId: skill.id, name: skill.name, lastUsedAt: at, assignments }];
  });
};

const behindOf = (input: HealthInput): SkillHealth["behind"] => {
  const byId = new Map(input.skills.map((skill) => [skill.id, skill]));
  return input.assignments.flatMap((one) => {
    const skill = byId.get(one.skillId);
    if (skill === undefined || one.pin === skill.latest) return [];
    const { id: assignmentId, skillId, scope, pin, held } = one;
    const number = input.numbers.get(pin) ?? null;
    return [{ assignmentId, skillId, name: skill.name, scope, pin, number, latest: skill.revisions, held }];
  });
};

const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

const clashesOf = (hob: HealthHob): SkillHealth["clashes"] => {
  const { agentId, resolved } = hob;
  const projects = resolved.clashes.map((clash) => ({
    agentId,
    name: clash.name,
    kind: "projects" as const,
    skillIds: unique(clash.assignments.map((one) => one.skillId)),
  }));
  // The same skill given in a wider and a narrower place is a pin, not a clash: only another skill counts.
  const replaced = resolved.replaced
    .filter((one) => one.assignment.skillId !== one.by.skillId)
    .map((one) => ({
      agentId,
      name: one.name,
      kind: "replaced" as const,
      skillIds: [one.by.skillId, one.assignment.skillId],
    }));
  const names = new Map<SkillName, Array<SkillId>>();
  for (const skill of resolved.skills) names.set(skill.name, [...(names.get(skill.name) ?? []), skill.skillId]);
  const same = [...names].flatMap(([name, ids]) =>
    ids.length > 1 ? [{ agentId, name, kind: "same-scope" as const, skillIds: unique(ids) }] : [],
  );
  return [...projects, ...replaced, ...same];
};

const descriptionsOf = (input: HealthInput): SkillHealth["descriptions"] =>
  input.skills.flatMap((skill) => {
    const revision = input.newest.get(skill.id);
    const members =
      revision?.set == null
        ? [{ name: skill.name, set: null, description: skill.description }]
        : revision.set.skills.map((one) => ({ name: one.name, set: skill.name, description: one.description }));
    return members.flatMap((one) => {
      const problem = descriptionProblem(one.description);
      return problem === null
        ? []
        : [{ skillId: skill.id, name: one.name, set: one.set, problem, length: one.description.trim().length }];
    });
  });

const loadOf = (hob: HealthHob): SkillLoad => ({
  agentId: hob.agentId,
  runtime: hob.runtime,
  skills: hob.resolved.skills.length,
  // A skill only you can pick is left out of what the runtime lists (ADR 029, Only when asked).
  characters: hob.resolved.skills
    .filter((skill) => !skill.onlyWhenAsked)
    .reduce(
      (sum, skill) =>
        sum + listingCharacters({ ...skill, description: hob.descriptions.get(skillMentionOf(skill)) ?? "" }),
      0,
    ),
  budget: SKILL_LISTING_BUDGET,
});

/** Every health check, in the order the Overview shows them. */
export const skillHealth = (input: HealthInput): SkillHealth => ({
  unused: unusedOf(input),
  behind: behindOf(input),
  clashes: input.hobs.flatMap(clashesOf),
  descriptions: descriptionsOf(input),
  loads: input.hobs.map(loadOf),
});

/** A hob to check, with its skills as its next turn would get them. */
export interface HealthHobInput {
  readonly agentId: AgentId;
  readonly runtime: RuntimeKind;
  readonly resolved: ResolvedSkills;
}

/** Reads what the checks need from the library, and runs them for `hobs`. */
export const readSkillHealth = (library: SkillLibraryShape, hobs: ReadonlyArray<HealthHobInput>, now: string) =>
  Effect.gen(function* () {
    const skills = yield* library.list;
    const assignments = yield* library.assignments();
    const revisions = yield* Effect.forEach(skills, (skill) => library.revisions(skill.id));
    const all = revisions.flat();
    const newest = new Map(skills.flatMap((skill, at) => (revisions[at]?.[0] ? [[skill.id, revisions[at][0]]] : [])));
    const numbers = new Map(all.map((revision) => [`${revision.skillId}:${revision.hash}`, revision.number]));
    const pinned = new Map(
      assignments.flatMap((one) => {
        const number = numbers.get(`${one.skillId}:${one.pin}`);
        return number === undefined ? [] : [[one.pin as string, number]];
      }),
    );
    const descriptionOf = (skillId: SkillId, pin: string, name: string) => {
      const revision = all.find((one) => one.skillId === skillId && one.hash === pin);
      return revision?.set?.skills.find((one) => one.name === name)?.description ?? revision?.description ?? "";
    };
    return skillHealth({
      now,
      skills,
      newest,
      assignments,
      numbers: pinned,
      lastUsedAt: yield* library.lastUsedAt,
      hobs: hobs.map((hob) => ({
        ...hob,
        descriptions: new Map(
          hob.resolved.skills.map((skill) => [
            skillMentionOf(skill),
            descriptionOf(skill.skillId, skill.pin, skill.name),
          ]),
        ),
      })),
    });
  });

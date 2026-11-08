import { rolloutTargets, SkillLibrary, type SkillLibraryShape, type SkillRevisionInput } from "@hobbots/agents";
import {
  type Committed,
  countSkillUses,
  lastSkillUses,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillId,
  SkillInUse,
  SkillMovedOn,
  SkillNameChanged,
  SkillNameTaken,
  SkillNotFound,
  type SkillOptOut,
  type SkillOrigin,
  SkillReadOnly,
  SkillRevision,
  type SkillScope,
  SkillSource,
  SkillSourceId,
  type SkillUse,
  skillUsesSince,
} from "@hobbots/domain";
import { Effect, Layer } from "effect";

/**
 * The skills library in memory, for tests: the port's rules without a database. It journals
 * nothing, so every change answers no entries.
 */

const committed = <A>(value: A): Committed<A> => ({ value, entries: [] });
const scopeKey = (scope: SkillScope) => JSON.stringify(scope);
const originKey = (origin: SkillOrigin) => JSON.stringify(origin);

export const makeSkillLibraryFake = (now: () => string = () => new Date().toISOString()): SkillLibraryShape => {
  const skills = new Map<SkillId, Skill>();
  const revisions = new Map<SkillId, Array<SkillRevision>>();
  const sources: Array<SkillSource> = [];
  const assignments = new Map<SkillAssignmentId, SkillAssignment>();
  const optOuts: Array<SkillOptOut> = [];
  const uses: Array<SkillUse> = [];
  let sequence = 0;
  let ids = 0;
  const nextId = () => `fake-${++ids}`;

  const named = (name: string) => [...skills.values()].find((skill) => skill.name === name) ?? null;
  const revisionOf = (id: SkillId, hash: string) => revisions.get(id)?.find((one) => one.hash === hash) ?? null;
  const sourceFor = (origin: SkillOrigin | null) => {
    if (origin === null || origin._tag === "Written") return null;
    const found = sources.find((source) => originKey(source.origin) === originKey(origin));
    if (found !== undefined) return found;
    const source = new SkillSource({ id: SkillSourceId.make(nextId()), origin, addedAt: now() });
    sources.push(source);
    return source;
  };
  const assignmentOf = (id: SkillAssignmentId) =>
    Effect.suspend(() => {
      const found = assignments.get(id);
      return found === undefined ? Effect.fail(new SkillNotFound({ id })) : Effect.succeed(found);
    });
  const save = (assignment: SkillAssignment) => {
    assignments.set(assignment.id, assignment);
    return committed(assignment);
  };

  /** A skill from `~/.agents/skills` changes only from its folder (ADR 029). */
  const onlyFromItsFolder = (target: Skill, input: SkillRevisionInput) => {
    const source = sources.find((one) => one.id === target.sourceId);
    if (source?.origin._tag !== "AgentsFolder" || input.origin?._tag === "AgentsFolder") return Effect.void;
    const path = revisionOf(target.id, target.latest)?.path ?? target.name;
    return Effect.fail(
      new SkillReadOnly({ skillId: target.id, name: target.name, folder: `${source.origin.path}/${path}` }),
    );
  };

  /** The skill a revision goes to, or the revision it already is, as the port's rules say. */
  const targetOf = (skillId: SkillId | null, input: SkillRevisionInput) =>
    Effect.gen(function* () {
      const target = skillId === null ? named(input.name) : (skills.get(skillId) ?? null);
      if (skillId !== null && target === null) return yield* new SkillNotFound({ id: skillId });
      if (target === null) return { _tag: "Next" as const, skill: null };
      const retried = target.latest === input.hash;
      if (skillId !== null && input.after !== undefined && target.latest !== input.after && !retried) {
        return yield* new SkillMovedOn({ skillId: target.id, latest: target.latest });
      }
      const same = revisionOf(target.id, input.hash);
      if (same !== null) return { _tag: "Same" as const, skill: target, revision: same };
      if (skillId === null) return yield* new SkillNameTaken({ name: input.name, skillId: target.id });
      if (target.name !== input.name) {
        return yield* new SkillNameChanged({ skillId: target.id, name: target.name, given: input.name });
      }
      yield* onlyFromItsFolder(target, input);
      return { _tag: "Next" as const, skill: target };
    });

  const append = (target: Skill | null, input: SkillRevisionInput) => {
    const at = now();
    const source = sourceFor(input.origin);
    const id = target?.id ?? SkillId.make(nextId());
    const revision = new SkillRevision({
      ...input,
      set: input.set ?? null,
      skillId: id,
      number: (target?.revisions ?? 0) + 1,
      sourceId: source?.id ?? null,
      addedAt: at,
    });
    const skill = new Skill({
      id,
      name: input.name,
      description: input.description,
      latest: input.hash,
      revisions: revision.number,
      sourceId: source?.id ?? target?.sourceId ?? null,
      createdAt: target?.createdAt ?? at,
      updatedAt: at,
      revision: ++sequence,
    });
    skills.set(id, skill);
    revisions.set(id, [...(revisions.get(id) ?? []), revision]);
    return { skill, revision };
  };

  const operations = new Set<string>();
  const library: SkillLibraryShape = {
    list: Effect.sync(() => [...skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1))),
    get: (id) => Effect.sync(() => skills.get(id) ?? null),
    byName: (name) => Effect.sync(() => named(name)),
    revisions: (id) => Effect.sync(() => [...(revisions.get(id) ?? [])].reverse()),
    revision: (id, hash) => Effect.sync(() => revisionOf(id, hash)),
    sources: Effect.sync(() => [...sources]),
    addRevision: (skillId, input) =>
      Effect.gen(function* () {
        const target = yield* targetOf(skillId, input);
        if (target._tag === "Same") return committed({ skill: target.skill, revision: target.revision, added: false });
        return committed({ ...append(target.skill, input), added: true });
      }),
    assignments: (skillId) =>
      Effect.sync(() => [...assignments.values()].filter((one) => skillId === undefined || one.skillId === skillId)),
    assign: (input) =>
      Effect.gen(function* () {
        if (!skills.has(input.skillId)) return yield* new SkillNotFound({ id: input.skillId });
        if (revisionOf(input.skillId, input.pin) === null) return yield* new SkillNotFound({ id: input.pin });
        const found = [...assignments.values()].find(
          (one) => one.skillId === input.skillId && scopeKey(one.scope) === scopeKey(input.scope),
        );
        return save(
          new SkillAssignment({
            id: found?.id ?? SkillAssignmentId.make(nextId()),
            ...input,
            assignedAt: found?.assignedAt ?? now(),
            revision: ++sequence,
          }),
        );
      }),
    unassign: (id) =>
      Effect.sync(() => {
        const found = assignments.get(id);
        if (found === undefined) return null;
        assignments.delete(id);
        return committed(found);
      }),
    rollOut: (id, pin, by) =>
      Effect.gen(function* () {
        const before = yield* assignmentOf(id);
        if (revisionOf(before.skillId, pin) === null) return yield* new SkillNotFound({ id: pin });
        return save(new SkillAssignment({ ...before, pin, by, revision: ++sequence }));
      }),
    rollOutRevision: (skillId, pin, by, when, holds = []) =>
      Effect.gen(function* () {
        const revision = revisionOf(skillId, pin);
        if (revision === null) return yield* new SkillNotFound({ id: pin });
        const pending = revision.rolledOutAt === null && skills.get(skillId)?.latest === pin;
        if (when === "pending" && !pending) return committed([]);
        for (const hold of when === "pending" ? holds : []) {
          const one = assignments.get(hold.assignmentId);
          if (one?.skillId === skillId && one.held !== hold.held) {
            save(new SkillAssignment({ ...one, held: hold.held, revision: ++sequence }));
          }
        }
        const moved = rolloutTargets([...assignments.values()], skillId, pin).map(
          (one) => save(new SkillAssignment({ ...one, pin, by, revision: ++sequence })).value,
        );
        revisions.set(
          skillId,
          (revisions.get(skillId) ?? []).map((one) =>
            one === revision ? new SkillRevision({ ...one, rolledOutAt: one.rolledOutAt ?? now() }) : one,
          ),
        );
        return committed(moved);
      }),
    deliver: (operation, delivery) =>
      Effect.gen(function* () {
        if (operations.has(operation)) return null;
        operations.add(operation);
        if (delivery._tag === "Assign") {
          const assigned = yield* library.assign(delivery.input);
          return committed([assigned.value]);
        }
        return yield* library.rollOutRevision(delivery.skillId, delivery.pin, delivery.by, delivery.when);
      }),
    hold: (id, held) =>
      Effect.map(assignmentOf(id), (before) => save(new SkillAssignment({ ...before, held, revision: ++sequence }))),
    optOuts: (agentId) => Effect.sync(() => optOuts.filter((one) => agentId === undefined || one.agentId === agentId)),
    setOptOut: (agentId, skillId, optedOut, member = null) =>
      Effect.gen(function* () {
        if (!skills.has(skillId)) return yield* new SkillNotFound({ id: skillId });
        const index = optOuts.findIndex(
          (one) => one.agentId === agentId && one.skillId === skillId && one.member === member,
        );
        if (optedOut === (index !== -1)) return null;
        if (!optedOut) return committed(optOuts.splice(index, 1)[0] as SkillOptOut);
        const optOut: SkillOptOut = { agentId, skillId, member, at: now() };
        optOuts.push(optOut);
        return committed(optOut);
      }),
    remove: (id) =>
      Effect.gen(function* () {
        const skill = skills.get(id);
        if (skill === undefined) return yield* new SkillNotFound({ id });
        const using = [...assignments.values()].filter((one) => one.skillId === id);
        if (using.length > 0) return yield* new SkillInUse({ skillId: id, assignments: using });
        skills.delete(id);
        for (let index = optOuts.length - 1; index >= 0; index -= 1) {
          if (optOuts[index]?.skillId === id) optOuts.splice(index, 1);
        }
        return committed(new Skill({ ...skill, updatedAt: now(), revision: ++sequence }));
      }),
    recordUse: (use) =>
      Effect.sync(() => {
        uses.unshift(use);
        return committed(use);
      }),
    uses: (filter) =>
      Effect.sync(() =>
        uses
          .filter(
            (use) =>
              (filter.skillId === undefined || use.skillId === filter.skillId) &&
              (filter.agentId === undefined || use.agentId === filter.agentId) &&
              (filter.messageId === undefined || use.messageId === filter.messageId),
          )
          .slice(0, filter.limit ?? 100),
      ),
    useCounts: (skillId, since) => Effect.sync(() => countSkillUses(skillId, uses, since)),
    usesSince: (since) => Effect.sync(() => skillUsesSince(uses, since)),
    lastUses: (agentId, limit) =>
      Effect.sync(() => lastSkillUses(uses.filter((use) => use.agentId === agentId)).slice(0, limit)),
    lastUsedAt: Effect.sync(() =>
      lastSkillUses(uses)
        .flatMap((use) => (use.skillId === null ? [] : [{ skillId: use.skillId, at: use.at }]))
        .sort((a, b) => a.skillId.localeCompare(b.skillId)),
    ),
  };
  return library;
};

/** `SkillLibrary` in memory, fresh for each build of the layer. */
export const SkillLibraryFake = Layer.sync(SkillLibrary, () => SkillLibrary.of(makeSkillLibraryFake()));

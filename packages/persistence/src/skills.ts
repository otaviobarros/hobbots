import { type SkillAssignmentInput, SkillLibrary, type SkillRevisionInput } from "@hobbots/agents";
import {
  AgentId,
  type JournaledEvent,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillBy,
  SkillDropped,
  SkillFile,
  SkillFlag,
  SkillId,
  SkillInUse,
  SkillMovedOn,
  type SkillName,
  SkillNameChanged,
  SkillNameTaken,
  SkillNotFound,
  type SkillOptOut,
  SkillOrigin,
  SkillRevision,
  type SkillRevisionHash,
  SkillScope,
  SkillSource,
  SkillSourceId,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";
import { skillUses } from "./skill-uses.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface SkillRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly latest: string;
  readonly revisions: unknown;
  readonly sourceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: unknown;
}

interface RevisionRow {
  readonly skillId: string;
  readonly hash: string;
  readonly number: unknown;
  readonly name: string;
  readonly description: string;
  readonly charms: string;
  readonly files: string;
  readonly flags: string;
  readonly dropped: string;
  readonly sourceId: string | null;
  readonly commitSha: string | null;
  readonly path: string | null;
  readonly label: string | null;
  readonly addedBy: string;
  readonly addedAt: string;
  readonly rolledOutAt: string | null;
}

interface AssignmentRow {
  readonly id: string;
  readonly skillId: string;
  readonly scope: string;
  readonly pin: string;
  readonly held: unknown;
  readonly onlyWhenAsked: unknown;
  readonly assignedBy: string;
  readonly assignedAt: string;
  readonly revision: unknown;
}

interface SourceRow {
  readonly id: string;
  readonly origin: string;
  readonly addedAt: string;
}

interface OptOutRow {
  readonly agentId: string;
  readonly skillId: string;
  readonly optedOutAt: string;
}

const decodeSkill = Schema.decodeUnknownEffect(Skill);
const decodeRevision = Schema.decodeUnknownEffect(SkillRevision);
const decodeAssignment = Schema.decodeUnknownEffect(SkillAssignment);
const decodeSource = Schema.decodeUnknownEffect(SkillSource);
const scopeJson = Schema.encodeSync(Schema.fromJsonString(SkillScope));
const byJson = Schema.encodeSync(Schema.fromJsonString(SkillBy));
const originJson = Schema.encodeSync(Schema.fromJsonString(SkillOrigin));
const filesJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SkillFile)));
const flagsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SkillFlag)));
const droppedJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SkillDropped)));

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every count and revision fits a number.
const skillOf = (row: SkillRow) =>
  decodeSkill({ ...row, revisions: Number(row.revisions), revision: Number(row.revision) }).pipe(Effect.orDie);

const revisionOf = (row: RevisionRow) =>
  decodeRevision({
    skillId: row.skillId,
    hash: row.hash,
    number: Number(row.number),
    name: row.name,
    description: row.description,
    charms: JSON.parse(row.charms),
    files: JSON.parse(row.files),
    flags: JSON.parse(row.flags),
    dropped: JSON.parse(row.dropped),
    sourceId: row.sourceId,
    commit: row.commitSha,
    path: row.path,
    label: row.label,
    addedBy: JSON.parse(row.addedBy),
    addedAt: row.addedAt,
    rolledOutAt: row.rolledOutAt,
  }).pipe(Effect.orDie);

const assignmentOf = (row: AssignmentRow) =>
  decodeAssignment({
    id: row.id,
    skillId: row.skillId,
    scope: JSON.parse(row.scope),
    pin: row.pin,
    held: Boolean(Number(row.held)),
    onlyWhenAsked: Boolean(Number(row.onlyWhenAsked)),
    by: JSON.parse(row.assignedBy),
    assignedAt: row.assignedAt,
    revision: Number(row.revision),
  }).pipe(Effect.orDie);

const sourceOf = (row: SourceRow) =>
  decodeSource({ id: row.id, origin: JSON.parse(row.origin), addedAt: row.addedAt }).pipe(Effect.orDie);

const optOutOf = (row: OptOutRow): SkillOptOut => ({
  agentId: AgentId.make(row.agentId),
  skillId: SkillId.make(row.skillId),
  at: row.optedOutAt,
});

/** The key that keeps one assignment per skill and scope. */
const scopeKey = (scope: SkillScope): string => {
  switch (scope._tag) {
    case "Everyone":
      return "everyone";
    case "Project":
      return `project:${scope.identity}`;
    case "Hob":
      return `hob:${scope.agentId}`;
  }
};

/** The key that records a source once per origin. */
const originKey = (origin: SkillOrigin): string => {
  switch (origin._tag) {
    case "Written":
      return "written";
    case "Folder":
      return `folder:${origin.path}`;
    case "Archive":
      return `archive:${origin.fileName}`;
    case "Git":
      return `git:${origin.url}#${origin.ref ?? ""}`;
    case "AgentsFolder":
      return `agents:${origin.path}`;
  }
};

const now = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * The SQL record of the skills library (migration 0065). Every change is one transaction with the
 * journal's head taken first, so two writers take turns on PostgreSQL, and a refusal rolls it back.
 */
/** What a change inside a journaled transaction makes, with the events it journals. */
interface Changed<A> {
  readonly value: A;
  readonly events: ReadonlyArray<JournaledEvent>;
}

export const SkillLibraryLive = Layer.effect(
  SkillLibrary,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);

    const skillRow = (id: SkillId) =>
      sql<SkillRow>`SELECT * FROM skills WHERE id = ${id} AND removed_at IS NULL`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : skillOf(row))),
      );
    const namedRow = (name: SkillName) =>
      sql<SkillRow>`SELECT * FROM skills WHERE name = ${name} AND removed_at IS NULL`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : skillOf(row))),
      );
    const revisionRow = (id: SkillId, hash: SkillRevisionHash) =>
      sql<RevisionRow>`SELECT * FROM skill_revisions WHERE skill_id = ${id} AND hash = ${hash}`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : revisionOf(row))),
      );
    const assignmentRow = (id: SkillAssignmentId) =>
      sql<AssignmentRow>`SELECT * FROM skill_assignments WHERE id = ${id}`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : assignmentOf(row))),
      );
    const assignmentsOf = (skillId?: SkillId) =>
      (skillId === undefined
        ? sql<AssignmentRow>`SELECT * FROM skill_assignments ORDER BY assigned_at, id`
        : sql<AssignmentRow>`SELECT * FROM skill_assignments WHERE skill_id = ${skillId} ORDER BY assigned_at, id`
      ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, assignmentOf)));

    /** The source for `origin`, recorded now when it is new. */
    const sourceFor = (origin: SkillOrigin | null, at: string) =>
      Effect.gen(function* () {
        if (origin === null || origin._tag === "Written") return { source: null, added: null };
        const key = originKey(origin);
        const [found] = yield* sql<SourceRow>`SELECT * FROM skill_sources WHERE origin_key = ${key}`;
        if (found !== undefined) return { source: yield* sourceOf(found), added: null };
        const source = new SkillSource({ id: SkillSourceId.make(crypto.randomUUID()), origin, addedAt: at });
        yield* sql`INSERT INTO skill_sources ${sql.insert({
          id: source.id,
          origin: originJson(origin),
          origin_key: key,
          added_at: at,
        })}`;
        return { source, added: source };
      });

    const insertRevision = (revision: SkillRevision) =>
      sql`INSERT INTO skill_revisions ${sql.insert({
        skill_id: revision.skillId,
        hash: revision.hash,
        number: revision.number,
        name: revision.name,
        description: revision.description,
        charms: JSON.stringify(revision.charms),
        files: filesJson(revision.files),
        flags: flagsJson(revision.flags),
        dropped: droppedJson(revision.dropped),
        source_id: revision.sourceId,
        commit_sha: revision.commit,
        path: revision.path,
        label: revision.label,
        added_by: byJson(revision.addedBy),
        added_at: revision.addedAt,
        rolled_out_at: revision.rolledOutAt,
      })}`;

    const writeSkill = (skill: Skill, isNew: boolean) =>
      isNew
        ? sql`INSERT INTO skills ${sql.insert({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            latest: skill.latest,
            revisions: skill.revisions,
            source_id: skill.sourceId,
            created_at: skill.createdAt,
            updated_at: skill.updatedAt,
            removed_at: null,
            revision: skill.revision,
          })}`
        : sql`UPDATE skills SET description = ${skill.description}, latest = ${skill.latest},
            revisions = ${skill.revisions}, source_id = ${skill.sourceId}, updated_at = ${skill.updatedAt},
            revision = ${skill.revision}
          WHERE id = ${skill.id}`;

    /** The skill a revision goes to, or the revision it already is. */
    const targetOf = (skillId: SkillId | null, input: SkillRevisionInput) =>
      Effect.gen(function* () {
        if (skillId === null) {
          const named = yield* namedRow(input.name);
          if (named === null) return { _tag: "New" as const };
          const same = yield* revisionRow(named.id, input.hash);
          if (same !== null) return { _tag: "Same" as const, skill: named, revision: same };
          return yield* new SkillNameTaken({ name: input.name, skillId: named.id });
        }
        const skill = yield* skillRow(skillId);
        if (skill === null) return yield* new SkillNotFound({ id: skillId });
        // Built on files of a revision that is no longer the newest: refused, so nothing it kept goes back.
        if (input.after !== undefined && skill.latest !== input.after) {
          return yield* new SkillMovedOn({ skillId: skill.id, expected: input.after, latest: skill.latest });
        }
        const same = yield* revisionRow(skill.id, input.hash);
        if (same !== null) return { _tag: "Same" as const, skill, revision: same };
        if (skill.name !== input.name) {
          return yield* new SkillNameChanged({ skillId: skill.id, name: skill.name, given: input.name });
        }
        return { _tag: "Next" as const, skill };
      });

    const addRevision = (skillId: SkillId | null, input: SkillRevisionInput) =>
      change<
        { skill: Skill; revision: SkillRevision; added: boolean },
        SkillNotFound | SkillNameTaken | SkillNameChanged | SkillMovedOn | SqlError.SqlError
      >((first) =>
        Effect.gen(function* () {
          const target = yield* targetOf(skillId, input);
          if (target._tag === "Same") {
            return { value: { skill: target.skill, revision: target.revision, added: false }, events: [] };
          }
          const at = yield* now;
          const { source, added } = yield* sourceFor(input.origin, at);
          const previous = target._tag === "Next" ? target.skill : null;
          const id = previous?.id ?? SkillId.make(crypto.randomUUID());
          const revision = new SkillRevision({
            skillId: id,
            hash: input.hash,
            number: (previous?.revisions ?? 0) + 1,
            name: input.name,
            description: input.description,
            charms: input.charms,
            files: input.files,
            flags: input.flags,
            dropped: input.dropped,
            sourceId: source?.id ?? null,
            commit: input.commit,
            path: input.path,
            label: input.label,
            addedBy: input.addedBy,
            addedAt: at,
          });
          const skill = new Skill({
            id,
            name: input.name,
            description: input.description,
            latest: input.hash,
            revisions: revision.number,
            sourceId: source?.id ?? previous?.sourceId ?? null,
            createdAt: previous?.createdAt ?? at,
            updatedAt: at,
            revision: first,
          });
          yield* writeSkill(skill, previous === null);
          yield* insertRevision(revision);
          const events: ReadonlyArray<JournaledEvent> = [
            { _tag: "SkillRevisionAdded", skill, revision, source: added },
          ];
          return { value: { skill, revision, added: true }, events };
        }),
      );

    /** Reads an assignment and fails when there is none, or when its new pin is not its skill's. */
    const existingAssignment = (id: SkillAssignmentId) =>
      Effect.flatMap(assignmentRow(id), (found) =>
        found === null ? Effect.fail(new SkillNotFound({ id })) : Effect.succeed(found),
      );

    const knownPin = (skillId: SkillId, pin: SkillRevisionHash) =>
      Effect.flatMap(revisionRow(skillId, pin), (found) =>
        found === null ? Effect.fail(new SkillNotFound({ id: pin })) : Effect.void,
      );

    const saveAssignment = (assignment: SkillAssignment) =>
      sql`UPDATE skill_assignments SET pin = ${assignment.pin}, held = ${assignment.held ? 1 : 0},
          only_when_asked = ${assignment.onlyWhenAsked ? 1 : 0}, assigned_by = ${byJson(assignment.by)},
          revision = ${assignment.revision}
        WHERE id = ${assignment.id}`;

    /** Assigns a skill to a scope, or changes its assignment there, inside a journaled change. */
    const assignIn = (first: number, input: SkillAssignmentInput) =>
      Effect.gen(function* (): Effect.fn.Return<Changed<SkillAssignment>, SkillNotFound | SqlError.SqlError> {
        if ((yield* skillRow(input.skillId)) === null) return yield* new SkillNotFound({ id: input.skillId });
        yield* knownPin(input.skillId, input.pin);
        const key = scopeKey(input.scope);
        const [found] = yield* sql<AssignmentRow>`SELECT * FROM skill_assignments
          WHERE skill_id = ${input.skillId} AND scope_key = ${key}`;
        const fields = { pin: input.pin, held: input.held, onlyWhenAsked: input.onlyWhenAsked, by: input.by };
        if (found !== undefined) {
          const before = yield* assignmentOf(found);
          const assignment = new SkillAssignment({ ...before, ...fields, revision: first });
          yield* saveAssignment(assignment);
          const events: Array<JournaledEvent> = [{ _tag: "SkillAssigned", assignment }];
          return { value: assignment, events };
        }
        const assignment = new SkillAssignment({
          id: SkillAssignmentId.make(crypto.randomUUID()),
          skillId: input.skillId,
          scope: input.scope,
          ...fields,
          assignedAt: yield* now,
          revision: first,
        });
        yield* sql`INSERT INTO skill_assignments ${sql.insert({
          id: assignment.id,
          skill_id: assignment.skillId,
          scope: scopeJson(assignment.scope),
          scope_key: key,
          pin: assignment.pin,
          held: assignment.held ? 1 : 0,
          only_when_asked: assignment.onlyWhenAsked ? 1 : 0,
          assigned_by: byJson(assignment.by),
          assigned_at: assignment.assignedAt,
          revision: first,
        })}`;
        return { value: assignment, events: [{ _tag: "SkillAssigned", assignment }] };
      });

    /** Rolls a revision out to the skill's assignments, inside a journaled change. */
    const rollOutIn = (
      first: number,
      skillId: SkillId,
      pin: SkillRevisionHash,
      by: SkillBy,
      when: "pending" | "always",
    ) =>
      Effect.gen(function* (): Effect.fn.Return<
        Changed<ReadonlyArray<SkillAssignment>>,
        SkillNotFound | SqlError.SqlError
      > {
        yield* knownPin(skillId, pin);
        // A save's own rollout claims the revision first, in this transaction: only the newest,
        // never rolled out, so a second save of it, or one after a rollback, moves nothing.
        const claimed = yield* sql<{
          readonly hash: string;
        }>`UPDATE skill_revisions SET rolled_out_at = ${yield* now}
          WHERE skill_id = ${skillId} AND hash = ${pin} AND rolled_out_at IS NULL
            AND hash = (SELECT latest FROM skills WHERE id = ${skillId}) RETURNING hash`;
        if (when === "pending" && claimed.length === 0) return { value: [], events: [] };
        const moved: Array<SkillAssignment> = [];
        const events: Array<JournaledEvent> = [];
        for (const before of yield* assignmentsOf(skillId)) {
          if (before.held || before.pin === pin) continue;
          // Moved only while it is still not held and still on the pin it was read with, so a
          // Keep on rN that lands meanwhile is never overwritten.
          const [row] = yield* sql<AssignmentRow>`UPDATE skill_assignments
            SET pin = ${pin}, assigned_by = ${byJson(by)}, revision = ${first}
            WHERE id = ${before.id} AND held = 0 AND pin = ${before.pin} RETURNING *`;
          if (row === undefined) continue;
          const assignment = yield* assignmentOf(row);
          moved.push(assignment);
          events.push({ _tag: "SkillRolledOut", assignment, from: before.pin });
        }
        if (claimed.length === 0) {
          yield* sql`UPDATE skill_revisions SET rolled_out_at = COALESCE(rolled_out_at, ${yield* now})
            WHERE skill_id = ${skillId} AND hash = ${pin}`;
        }
        return { value: moved, events };
      });

    return SkillLibrary.of({
      list: sqlOrDie(
        sql<SkillRow>`SELECT * FROM skills WHERE removed_at IS NULL ORDER BY name`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, skillOf)),
        ),
      ),
      get: (id) => sqlOrDie(skillRow(id)),
      byName: (name) => sqlOrDie(namedRow(name)),
      revisions: (id) =>
        sqlOrDie(
          sql<RevisionRow>`SELECT r.* FROM skill_revisions r JOIN skills s ON s.id = r.skill_id
            WHERE r.skill_id = ${id} AND s.removed_at IS NULL ORDER BY r.number DESC`.pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, revisionOf)),
          ),
        ),
      revision: (id, hash) => sqlOrDie(revisionRow(id, hash)),
      sources: sqlOrDie(
        sql<SourceRow>`SELECT * FROM skill_sources ORDER BY added_at, id`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, sourceOf)),
        ),
      ),
      addRevision,
      assignments: (skillId) => sqlOrDie(assignmentsOf(skillId)),
      assign: (input) => change<SkillAssignment, SkillNotFound | SqlError.SqlError>((first) => assignIn(first, input)),
      unassign: (id) =>
        change<SkillAssignment | null, SqlError.SqlError>(() =>
          Effect.gen(function* () {
            const [row] = yield* sql<AssignmentRow>`DELETE FROM skill_assignments WHERE id = ${id} RETURNING *`;
            if (row === undefined) return { value: null, events: [] };
            const assignment = yield* assignmentOf(row);
            return { value: assignment, events: [{ _tag: "SkillUnassigned", assignment }] };
          }),
        ).pipe(Effect.map((committed) => (committed.value === null ? null : { ...committed, value: committed.value }))),
      rollOut: (id, pin, by) =>
        change<SkillAssignment, SkillNotFound | SqlError.SqlError>((first) =>
          Effect.gen(function* () {
            const before = yield* existingAssignment(id);
            yield* knownPin(before.skillId, pin);
            const assignment = new SkillAssignment({ ...before, pin, by, revision: first });
            yield* saveAssignment(assignment);
            return { value: assignment, events: [{ _tag: "SkillRolledOut", assignment, from: before.pin }] };
          }),
        ),
      rollOutRevision: (skillId, pin, by, when) =>
        change<ReadonlyArray<SkillAssignment>, SkillNotFound | SqlError.SqlError>((first) =>
          rollOutIn(first, skillId, pin, by, when),
        ),
      deliver: (operation, delivery) =>
        change<ReadonlyArray<SkillAssignment> | null, SkillNotFound | SqlError.SqlError>((first) =>
          Effect.gen(function* (): Effect.fn.Return<
            Changed<ReadonlyArray<SkillAssignment> | null>,
            SkillNotFound | SqlError.SqlError
          > {
            // The receipt is taken first, in this transaction: an operation made already moves nothing.
            const [taken] = yield* sql<{ readonly operation: string }>`INSERT INTO skill_operations ${sql.insert({
              operation,
              done_at: yield* now,
            })} ON CONFLICT (operation) DO NOTHING RETURNING operation`;
            if (taken === undefined) return { value: null, events: [] };
            if (delivery._tag === "Assign") {
              const assigned = yield* assignIn(first, delivery.input);
              return { value: [assigned.value], events: assigned.events };
            }
            return yield* rollOutIn(first, delivery.skillId, delivery.pin, delivery.by, delivery.when);
          }),
        ).pipe(Effect.map((committed) => (committed.value === null ? null : { ...committed, value: committed.value }))),
      hold: (id, held) =>
        change<SkillAssignment, SkillNotFound | SqlError.SqlError>((first) =>
          Effect.gen(function* () {
            const before = yield* existingAssignment(id);
            const assignment = new SkillAssignment({ ...before, held, revision: first });
            yield* saveAssignment(assignment);
            return { value: assignment, events: [{ _tag: "SkillHeld", assignment }] };
          }),
        ),
      optOuts: (agentId) =>
        sqlOrDie(
          (agentId === undefined
            ? sql<OptOutRow>`SELECT * FROM skill_opt_outs ORDER BY agent_id, skill_id`
            : sql<OptOutRow>`SELECT * FROM skill_opt_outs WHERE agent_id = ${agentId} ORDER BY skill_id`
          ).pipe(Effect.map((rows) => rows.map(optOutOf))),
        ),
      setOptOut: (agentId, skillId, optedOut) =>
        change<SkillOptOut | null, SkillNotFound | SqlError.SqlError>(() =>
          Effect.gen(function* () {
            if ((yield* skillRow(skillId)) === null) return yield* new SkillNotFound({ id: skillId });
            const rows = optedOut
              ? yield* sql<OptOutRow>`INSERT INTO skill_opt_outs ${sql.insert({
                  agent_id: agentId,
                  skill_id: skillId,
                  opted_out_at: yield* now,
                })} ON CONFLICT (agent_id, skill_id) DO NOTHING RETURNING *`
              : yield* sql<OptOutRow>`DELETE FROM skill_opt_outs
                  WHERE agent_id = ${agentId} AND skill_id = ${skillId} RETURNING *`;
            const [row] = rows;
            if (row === undefined) return { value: null, events: [] };
            const optOut = optOutOf(row);
            return { value: optOut, events: [{ _tag: "SkillOptOutChanged", optOut, optedOut }] };
          }),
        ).pipe(Effect.map((committed) => (committed.value === null ? null : { ...committed, value: committed.value }))),
      remove: (id) =>
        change<Skill, SkillNotFound | SkillInUse | SqlError.SqlError>((first) =>
          Effect.gen(function* () {
            const before = yield* skillRow(id);
            if (before === null) return yield* new SkillNotFound({ id });
            const assignments = yield* assignmentsOf(id);
            if (assignments.length > 0) return yield* new SkillInUse({ skillId: id, assignments });
            const at = yield* now;
            const skill = new Skill({ ...before, updatedAt: at, revision: first });
            yield* sql`DELETE FROM skill_opt_outs WHERE skill_id = ${id}`;
            yield* sql`UPDATE skills SET removed_at = ${at}, updated_at = ${at}, revision = ${first} WHERE id = ${id}`;
            return { value: skill, events: [{ _tag: "SkillRemoved", skill }] };
          }),
        ),
      ...skillUses(sql, change),
    });
  }),
);

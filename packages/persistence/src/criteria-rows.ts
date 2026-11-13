import type { CriterionCheck, EvidenceClaim, NewCriterion, NewQuest, TaskRepository } from "@hobbots/agents";
import {
  type Artifact,
  Criteria,
  Criterion,
  type CriterionEvent,
  CriterionId,
  canonicalPath,
  descendantsOf,
  type Evidence,
  IllegalCriterionTransition,
  type JournaledEvent,
  Quest,
  QuestStates,
  type RegisteredArtifactId,
  type TaskId,
  type TaskRefusal,
  TaskRefused,
} from "@hobbots/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { type ArtifactRow, artifactFromRow, tasksThatMade } from "./artifact-rows.ts";
import type { makeJournaledChange } from "./journal.ts";
import { makeTaskReads } from "./task-rows.ts";

// A Quest's acceptance criteria (#1445), kept as JSON on its row, in order. Each change goes through
// `CriterionMachine` and is journaled as `QuestCriteriaChanged`, with the whole Quest.

const refuse = (reason: TaskRefusal, message: string) => Effect.fail(new TaskRefused({ reason, message }));

/** The criteria a new Quest starts with: those its lead gave, or each line of its acceptance, required. */
export const criteriaOf = (input: NewQuest): ReadonlyArray<Criterion> => {
  const given: ReadonlyArray<NewCriterion> =
    input.criteria ??
    input.acceptance.map((text) => ({ id: CriterionId.make(crypto.randomUUID()), text, required: true }));
  return given.map((each) => new Criterion({ ...each, taskIds: [], state: "open", evidence: [], decided: null }));
};

/** Writes a Quest's criteria at journal sequence `revision`, with the Quest as it now stands. */
const saveCriteria = (sql: SqlClient.SqlClient, quest: Quest, criteria: ReadonlyArray<Criterion>, revision: number) =>
  Effect.as(
    sql`UPDATE quests SET criteria = ${JSON.stringify(criteria)}, revision = ${revision} WHERE id = ${quest.id}`,
    new Quest({ ...quest, criteria, revision }),
  );

/** One artifact a claim names, with the version checked and the Task that made it. */
interface Found {
  readonly artifact: Artifact;
  readonly version: number;
  readonly taskId: TaskId | null;
}

/**
 * The artifact a Task returned (`ArtifactRef`), as the registry keeps it: the version its record
 * made, and the Task that returned it. Null when it is no result of `within`.
 */
const returned = (sql: SqlClient.SqlClient, artifactId: string, within: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const [row] = yield* sql<ArtifactRow & { readonly sightingVersion: number | string; readonly refTaskId: string }>`
      SELECT a.*, s.version AS sighting_version, r.task_id AS ref_task_id FROM artifact_refs r
        JOIN artifact_sightings s ON s.origin_kind = 'task-artifact' AND s.origin_id = r.id
        JOIN artifacts a ON a.id = s.artifact_id
        WHERE r.id = ${artifactId}`;
    if (row === undefined || !within.has(row.refTaskId)) return null;
    return {
      artifact: yield* artifactFromRow(row),
      version: Number(row.sightingVersion),
      taskId: row.refTaskId as TaskId,
    } satisfies Found;
  });

/** The file at `path` in the Quest's chat or camp, at its latest version, when a Task in `within` made it. */
const file = (sql: SqlClient.SqlClient, quest: Quest, path: string, within: ReadonlySet<string>) =>
  Effect.gen(function* () {
    if (quest.threadId === null) return null;
    const [row] = yield* sql<ArtifactRow>`SELECT * FROM artifacts
      WHERE thread_id = ${quest.threadId} AND locator = ${canonicalPath(path)}`;
    if (row === undefined) return null;
    const made = (yield* tasksThatMade(sql, [row.id])).filter((taskId) => within.has(taskId));
    const [taskId] = made;
    if (taskId === undefined) return null;
    const artifact = yield* artifactFromRow(row);
    return { artifact, version: artifact.latestVersion, taskId: taskId as TaskId } satisfies Found;
  });

const claimed = (claim: EvidenceClaim) => (claim._tag === "Returned" ? claim.artifactId : claim.path);

/**
 * The evidence the claims name, each tied to the version checked. Refused for one that is no
 * artifact of a Task in the Quest, or whose version a newer one already replaced.
 */
const evidenceOf = (sql: SqlClient.SqlClient, quest: Quest, claims: ReadonlyArray<EvidenceClaim>) =>
  Effect.gen(function* () {
    const read = makeTaskReads(sql);
    const [top] = yield* read.task(quest.taskId);
    const tree = top === undefined ? [] : [top, ...descendantsOf(top, yield* read.treeOf(top.rootId))];
    const within = new Set<string>(tree.map((each) => each.id));
    const evidence: Array<Evidence> = [];
    for (const claim of claims) {
      const found =
        claim._tag === "Returned"
          ? yield* returned(sql, claim.artifactId, within)
          : yield* file(sql, quest, claim.path, within);
      if (found === null) {
        return yield* refuse(
          "evidence-missing",
          `${claimed(claim)} is no artifact a Task in Quest ${quest.id} returned, and no file one made or changed in its chat or camp.`,
        );
      }
      if (found.version < found.artifact.latestVersion) {
        return yield* refuse(
          "evidence-stale",
          `${claimed(claim)} is version ${found.version} of "${found.artifact.title}", and version ${found.artifact.latestVersion} replaced it. Check the latest: name it by its path, ${found.artifact.locator}.`,
        );
      }
      if (evidence.some((each) => each.artifactId === found.artifact.id)) continue;
      evidence.push({
        artifactId: found.artifact.id,
        version: found.version,
        taskId: found.taskId,
        label: found.artifact.title,
        voidedAt: null,
      });
    }
    return evidence;
  });

/** What a refused check is told, by the state the criterion is in. */
const notAllowed = (criterion: Criterion, check: CriterionCheck) => {
  if (check._tag === "Waive" && criterion.required && check.by.kind !== "user") {
    return `Criterion ${criterion.id} is required: only the user waives it.`;
  }
  if (check._tag === "Accept" && check.evidence.length === 0) {
    return `Criterion ${criterion.id} is accepted only on evidence: name the artifacts that prove it.`;
  }
  return `Criterion ${criterion.id} is ${criterion.state}, so it cannot be ${check._tag === "Accept" ? "accepted" : check._tag === "Rework" ? "sent back for rework" : "waived"} now.`;
};

/** The SQL writes of a Quest's criteria: checks and links, journaled with the whole Quest. */
export const makeCriteriaChanges = (
  sql: SqlClient.SqlClient,
  change: ReturnType<typeof makeJournaledChange>,
): Pick<TaskRepository["Service"], "checkCriterion" | "linkCriteria"> => {
  const read = makeTaskReads(sql);

  const questOf = (questId: string) =>
    Effect.gen(function* () {
      const [quest] = yield* read.quest(questId);
      return quest === undefined ? yield* refuse("quest-missing", `No Quest ${questId}`) : quest;
    });

  const missing = (quest: Quest, ids: ReadonlyArray<string>) => {
    const known = new Set<string>(quest.criteria.map((each) => each.id));
    const unknown = ids.filter((id) => !known.has(id));
    const listed = quest.criteria.map((each) => `${each.id} "${each.text}"`).join("; ");
    return unknown.length === 0
      ? null
      : `Quest ${quest.id} has no criterion ${unknown.join(", ")}. ${
          quest.criteria.length === 0 ? "It has no acceptance criteria." : `Its criteria: ${listed}.`
        }`;
  };

  return {
    checkCriterion: (questId, criterionId, check) =>
      change((revision) =>
        Effect.gen(function* () {
          const quest = yield* questOf(questId);
          if (!QuestStates.takesWork(quest)) {
            return yield* refuse("quest-ended", `Quest ${questId} is ${quest.state}, so its criteria no longer change`);
          }
          const unknown = missing(quest, [criterionId]);
          if (unknown !== null) return yield* refuse("criterion-missing", unknown);
          const criterion = quest.criteria.find((each) => each.id === criterionId) as Criterion;
          const event: CriterionEvent =
            check._tag === "Accept" ? { ...check, evidence: yield* evidenceOf(sql, quest, check.evidence) } : check;
          const next = Criteria.transition(criterion, event);
          if (next instanceof IllegalCriterionTransition) {
            return yield* refuse("criterion-state", notAllowed(criterion, check));
          }
          const criteria = quest.criteria.map((each) => (each.id === criterionId ? next : each));
          const saved = yield* saveCriteria(sql, quest, criteria, revision);
          return { value: saved, events: [{ _tag: "QuestCriteriaChanged", quest: saved } as const] };
        }),
      ),
    linkCriteria: (questId, criterionIds, taskId) =>
      change((revision) =>
        Effect.gen(function* () {
          const quest = yield* questOf(questId);
          const unknown = missing(quest, criterionIds);
          if (unknown !== null) return yield* refuse("criterion-missing", unknown);
          const linked = new Set<string>(criterionIds);
          const criteria = quest.criteria.map((each) =>
            linked.has(each.id) && !each.taskIds.includes(taskId)
              ? new Criterion({ ...each, taskIds: [...each.taskIds, taskId] })
              : each,
          );
          const saved = yield* saveCriteria(sql, quest, criteria, revision);
          return { value: saved, events: [{ _tag: "QuestCriteriaChanged", quest: saved } as const] };
        }),
      ),
  };
};

/**
 * Voids the evidence a newer artifact version replaced (#1445), at journal sequences from `first`
 * on: each criterion of a Quest still under way in the artifact's chat or camp that was accepted on
 * an older version of it is open again. Returns their `QuestCriteriaChanged` events, one per Quest.
 * Only for use within `sql.withTransaction`, after the artifacts were registered.
 */
export const voidReplacedEvidence = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const artifacts = events.flatMap((event) => (event._tag === "ArtifactRegistered" ? [event.artifact] : []));
    if (artifacts.length === 0) return [];
    const read = makeTaskReads(sql);
    const changed: Array<JournaledEvent> = [];
    const threads = [...new Set(artifacts.map((artifact) => artifact.threadId))];
    for (const threadId of threads) {
      const quests = yield* read.questsIn(threadId);
      for (const quest of quests) {
        const criteria = quest.criteria.map((criterion) =>
          artifacts
            .filter((artifact) => artifact.threadId === threadId)
            .reduce(
              (each, artifact) => voided(each, artifact.id, artifact.latestVersion, artifact.updatedAt) ?? each,
              criterion,
            ),
        );
        if (criteria.every((each, index) => each === quest.criteria[index])) continue;
        const saved = yield* saveCriteria(sql, quest, criteria, first + changed.length);
        changed.push({ _tag: "QuestCriteriaChanged", quest: saved });
      }
    }
    return changed;
  });

/** A criterion with the evidence version `version` of `artifactId` replaced voided, or null when that changes nothing. */
const voided = (criterion: Criterion, artifactId: RegisteredArtifactId, version: number, at: string) => {
  const next = Criteria.transition(criterion, { _tag: "Void", artifactId, version, at });
  return next instanceof Criterion ? next : null;
};

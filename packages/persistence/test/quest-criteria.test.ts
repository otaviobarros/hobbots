import { HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  type Actor,
  Agent,
  AgentId,
  ArtifactId,
  AttemptId,
  CriterionId,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  DeviceId,
  type EventEnvelope,
  OWNER_ACTOR,
  type Quest,
  QuestId,
  QuestionId,
  type Task,
  TaskId,
  TaskRefused,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, migrations, TaskRepositoryLive } from "../src/index.ts";
import questCriteria from "../src/migrations/0113_quest_criteria.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1445: a Quest's acceptance criteria are checked against evidence. Each has an id, is
// required or optional and is linked to Tasks; it is accepted on evidence tied to an artifact
// version, sent back for rework or waived, with who, why and when. A newer version of an artifact
// voids the evidence, in the transaction that registers it, and a Quest completes only once each
// required criterion is accepted or waived. On SQLite and PostgreSQL alike.

const layer = Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E>);

const NOW = "2026-11-13T10:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const THREAD = ThreadId.make("launch");
const QUEST = QuestId.make("quest-launch");
const DATE = CriterionId.make("criterion-date");
const PHOTO = CriterionId.make("criterion-photo");
const PAGE = "/code/launch/index.html";
const LEAD: Actor = { kind: "hob", id: ALDRIC };
/** Your answer, from your session on your phone: a waiver you choose names you. */
const YOU = { deviceId: DeviceId.make("phone"), via: "chat", actor: OWNER_ACTOR } as const;

let clock = 0;
const tick = () => new Date(Date.parse(NOW) + 1000 * ++clock).toISOString();

const hob = (id: AgentId) =>
  new Agent({
    id,
    name: id,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });

/** A Task started on its first Attempt. */
const started = (id: string, ownerId: AgentId, parentId: TaskId | null) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const created = yield* tasks.createTask({
      task: {
        id: TaskId.make(id),
        ownerId,
        parentId,
        threadId: parentId === null ? THREAD : null,
        brief: id,
        dependsOn: [],
        createdAt: tick(),
      },
      delegation:
        parentId === null
          ? null
          : {
              id: DelegationId.make(`d-${id}`),
              brief: id,
              expectedOutput: null,
              authority: { overrides: {}, folders: null },
              timeoutMs: null,
            },
      milestones: [],
    });
    if (parentId === null) {
      yield* tasks.startQuest({
        id: QUEST,
        taskId: created.value.id,
        goal: "The launch page",
        acceptance: ["The page names the launch date", "The page has a photo"],
        criteria: [
          { id: DATE, text: "The page names the launch date", required: true },
          { id: PHOTO, text: "The page has a photo", required: false },
        ],
        limits: DEFAULT_QUEST_LIMITS,
        createdAt: tick(),
      });
    }
    const attempt = yield* tasks.startAttempt(created.value.id, created.value.revision, {
      id: AttemptId.make(`a-${id}`),
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: tick(),
    });
    return attempt.value.task;
  });

/** Completes a Task, returning the page as a file, or nothing. */
const complete = (taskId: TaskId, returned: string | null) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const [task] = Option.getOrThrow(yield* tasks.readTree(taskId)).tasks;
    if (task?.currentAttemptId == null) throw new Error(`no Attempt on ${taskId}`);
    const ledger = Option.getOrThrow(yield* tasks.readLedger(taskId));
    return yield* tasks.completeTask(taskId, task.revision, {
      summary: "Done",
      attemptId: task.currentAttemptId,
      artifacts:
        returned === null ? [] : [{ id: ArtifactId.make(returned), kind: "file", label: "Launch page", value: PAGE }],
      at: tick(),
      carried: carriedFrom(ledger, () => true),
    });
  });

const questNow = Effect.gen(function* () {
  const tasks = yield* TaskRepository;
  return Option.getOrThrow(yield* tasks.readTree(TaskId.make("campaign"))).quests[0] as Quest;
});

/** Why the hub refused a change; any other failure fails the test. */
const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.flip(effect), (error) =>
    error instanceof TaskRefused ? Effect.succeed([error.reason, error.message] as const) : Effect.die(error),
  );

const tags = (entries: ReadonlyArray<EventEnvelope>) => entries.map((entry) => entry.type);

describe("a Quest's acceptance criteria", () => {
  // covers OR-004, OR-006, DP-003
  it("[TC-DP-1445-04] holds the Quest open until each required one is accepted on evidence, and a newer version voids it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        for (const id of [ALDRIC, QUILL, ADA]) yield* repo.insertAgent(hob(id));
        yield* repo.upsertThread(
          new Thread({ id: THREAD, agentId: ALDRIC, title: "Launch", createdAt: NOW, updatedAt: NOW }),
        );
        const tasks = yield* TaskRepository;
        const top = yield* started("campaign", ALDRIC, null);
        const quill: Task = yield* started("page", QUILL, top.id);
        const ada: Task = yield* started("photo", ADA, top.id);
        const linked = yield* tasks.linkCriteria(QUEST, [DATE], quill.id);
        const unknownLink = yield* refusal(tasks.linkCriteria(QUEST, [CriterionId.make("nope")], quill.id));
        yield* complete(quill.id, "ref-quill");
        const accept = (evidence: Parameters<TaskRepository["Service"]["checkCriterion"]>[2]) =>
          tasks.checkCriterion(QUEST, DATE, evidence);
        const said = { by: LEAD, reason: "The page says Friday 6 December", at: tick() };
        const notEvidence = yield* refusal(
          accept({ ...said, _tag: "Accept", evidence: [{ _tag: "File", path: "/code/elsewhere.html" }] }),
        );
        const leadWaives = yield* refusal(tasks.checkCriterion(QUEST, DATE, { ...said, _tag: "Waive" }));
        const accepted = yield* accept({
          ...said,
          _tag: "Accept",
          evidence: [{ _tag: "Returned", artifactId: ArtifactId.make("ref-quill") }],
        });
        // Ada returns the same page from her own Attempt: its next version voids the evidence.
        const adaDone = yield* complete(ada.id, "ref-ada");
        const voided = yield* questNow;
        const stale = yield* refusal(
          accept({
            ...said,
            _tag: "Accept",
            evidence: [{ _tag: "Returned", artifactId: ArtifactId.make("ref-quill") }],
          }),
        );
        const early = yield* refusal(complete(top.id, null));
        const again = yield* accept({ ...said, _tag: "Accept", evidence: [{ _tag: "File", path: PAGE }] });
        const done = yield* complete(top.id, null);
        const after = yield* refusal(tasks.checkCriterion(QUEST, PHOTO, { ...said, _tag: "Waive" }));
        return {
          linked,
          unknownLink,
          notEvidence,
          leadWaives,
          accepted,
          adaDone,
          voided,
          stale,
          early,
          again,
          done,
          after,
        };
      }),
    );
    expect(result.linked.value.criteria.map((each) => [each.id, each.taskIds])).toEqual([
      [DATE, [TaskId.make("page")]],
      [PHOTO, []],
    ]);
    expect(tags(result.linked.entries)).toEqual(["QuestCriteriaChanged"]);
    expect(result.unknownLink[0]).toBe("criterion-missing");
    expect(result.notEvidence[0]).toBe("evidence-missing");
    expect(result.leadWaives).toEqual(["criterion-state", `Criterion ${DATE} is required: only the user waives it.`]);
    const [date] = result.accepted.value.criteria;
    expect(date).toMatchObject({
      state: "accepted",
      decided: { by: LEAD, reason: "The page says Friday 6 December" },
      evidence: [{ version: 1, taskId: "page", label: "Launch page", voidedAt: null }],
    });
    // The void is journaled with the completion that registered the newer version.
    expect(tags(result.adaDone.entries)).toContain("QuestCriteriaChanged");
    expect(result.voided.criteria[0]).toMatchObject({
      state: "open",
      decided: { by: { kind: "hub" } },
      evidence: [{ version: 1, voidedAt: expect.any(String) }],
    });
    expect(result.stale[0]).toBe("evidence-stale");
    expect(result.stale[1]).toContain(`name it by its path, ${PAGE}`);
    expect(result.early[0]).toBe("criteria-unmet");
    expect(result.early[1]).toContain(
      `${DATE} "The page names the launch date" (its evidence was voided by a newer version)`,
    );
    // The optional photo never held it open.
    expect(result.early[1]).not.toContain(PHOTO);
    expect(result.again.value.criteria[0]).toMatchObject({
      state: "accepted",
      evidence: [{ version: 2, taskId: "photo", voidedAt: null }],
    });
    expect(tags(result.done.entries)).toContain("QuestCompleted");
    expect(result.after[0]).toBe("quest-ended");
  });

  // covers OR-004
  it("[TC-DP-1445-05] waives a required criterion only on your answer to the question it asks you, and completes the Quest once you do", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        for (const id of [ALDRIC, QUILL, ADA]) yield* repo.insertAgent(hob(id));
        yield* repo.upsertThread(
          new Thread({ id: THREAD, agentId: ALDRIC, title: "Launch", createdAt: NOW, updatedAt: NOW }),
        );
        const tasks = yield* TaskRepository;
        const top = yield* started("campaign", ALDRIC, null);
        const said = { reason: "The date is not set yet", at: tick() };
        const rework = yield* tasks.checkCriterion(QUEST, DATE, { ...said, by: LEAD, _tag: "Rework" });
        const noProof = yield* refusal(
          tasks.checkCriterion(QUEST, DATE, { ...said, by: LEAD, _tag: "Accept", evidence: [] }),
        );
        const ask = (id: string) =>
          tasks.askToWaive(QUEST, DATE, { questionId: QuestionId.make(id), askerId: ALDRIC, ...said });
        const optional = yield* refusal(
          tasks.askToWaive(QUEST, PHOTO, { questionId: QuestionId.make("q-photo"), askerId: ALDRIC, ...said }),
        );
        const asked = yield* ask("q-keep");
        const twice = yield* refusal(ask("q-twice"));
        // "Keep it" leaves the criterion as it was.
        yield* tasks.answerQuestion(QuestionId.make("q-keep"), { _tag: "User" }, "Keep it", tick(), YOU);
        const kept = yield* questNow;
        const early = yield* refusal(complete(top.id, null));
        yield* ask("q-waive");
        const answered = yield* tasks.answerQuestion(
          QuestionId.make("q-waive"),
          { _tag: "User" },
          "waive it",
          tick(),
          YOU,
        );
        const waived = yield* questNow;
        const done = yield* complete(top.id, null);
        return { rework, noProof, optional, asked, twice, kept, early, answered, waived, done };
      }),
    );
    expect(result.rework.value.criteria[0]?.state).toBe("needs-rework");
    expect(result.noProof[0]).toBe("criterion-state");
    expect(result.optional).toEqual(["criterion-state", `Criterion ${PHOTO} is optional: waive it yourself.`]);
    // The question goes to you, whoever leads above, with the choices that decide it.
    expect(tags(result.asked.entries).slice(0, 2)).toEqual(["QuestionAsked", "QuestCriteriaChanged"]);
    expect(result.asked.value.question).toMatchObject({
      taskId: "campaign",
      askerId: ALDRIC,
      recipientId: null,
      text: 'Waive "The page names the launch date"? The date is not set yet',
      options: [{ label: "Waive it" }, { label: "Keep it" }],
    });
    expect(result.asked.value.quest.criteria[0]).toMatchObject({
      state: "needs-rework",
      waiverAsk: { questionId: "q-keep", reason: "The date is not set yet" },
    });
    expect(result.twice[0]).toBe("waiver-asked");
    expect(result.kept.criteria[0]).toMatchObject({ state: "needs-rework", waiverAsk: null });
    expect(result.early[0]).toBe("criteria-unmet");
    // Your answer and the waiver it makes are journaled together.
    expect(tags(result.answered.entries)).toEqual(expect.arrayContaining(["QuestionAnswered", "QuestCriteriaChanged"]));
    expect(result.waived.criteria[0]).toMatchObject({
      state: "waived",
      waiverAsk: null,
      decided: { by: OWNER_ACTOR, reason: "The date is not set yet" },
    });
    expect(tags(result.done.entries)).toContain("QuestCompleted");
  });

  // covers OR-004, OR-006, DP-003
  it("[TC-DP-1445-07] refuses a completion whose own artifacts void the evidence a criterion was accepted on, and changes nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        for (const id of [ALDRIC, QUILL, ADA]) yield* repo.insertAgent(hob(id));
        yield* repo.upsertThread(
          new Thread({ id: THREAD, agentId: ALDRIC, title: "Launch", createdAt: NOW, updatedAt: NOW }),
        );
        const tasks = yield* TaskRepository;
        const top = yield* started("campaign", ALDRIC, null);
        const quill = yield* started("page", QUILL, top.id);
        yield* complete(quill.id, "ref-quill");
        yield* tasks.checkCriterion(QUEST, DATE, {
          _tag: "Accept",
          by: LEAD,
          reason: "The page says Friday 6 December",
          at: tick(),
          evidence: [{ _tag: "Returned", artifactId: ArtifactId.make("ref-quill") }],
        });
        // Aldric returns the same page from his own Attempt: that would be its version 2.
        const returned = yield* refusal(complete(top.id, "ref-aldric"));
        const after = yield* questNow;
        const versions = yield* (yield* SqlClient.SqlClient)<{
          readonly latestVersion: number | string;
        }>`SELECT latest_version FROM artifacts`;
        const done = yield* complete(top.id, null);
        return { returned, after, versions, done };
      }),
    );
    expect(result.returned[0]).toBe("criteria-unmet");
    expect(result.returned[1]).toContain(
      `${DATE} "The page names the launch date" (its evidence was voided by a newer version)`,
    );
    expect(result.returned[1]).toContain('Returning "Launch page" from this completion makes a newer version');
    // The refusal rolled back the version it would have made, and the void with it.
    expect(result.versions.map((row) => Number(row.latestVersion))).toEqual([1]);
    expect(result.after.criteria[0]).toMatchObject({ state: "accepted", evidence: [{ version: 1, voidedAt: null }] });
    expect(result.after.state).toBe("active");
    expect(tags(result.done.entries)).toContain("QuestCompleted");
  });

  // covers DP-003
  it("[TC-DP-1445-06] gives every Quest stored before one required criterion per line of its acceptance", async () => {
    const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0114")) as typeof migrations;
    const rows = await Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      yield* sql`INSERT INTO agents ${sql.insert({
        id: ALDRIC,
        name: "Aldric",
        runtime: "claude-code",
        role_title: "Guide",
        instructions: "",
        look_seed: 1,
        look_color: "moss",
        created_at: NOW,
      })}`;
      for (const [id, acceptance] of [
        ["with", ["Copy approved", "Campaign built"]],
        ["without", []],
      ] as const) {
        yield* sql`INSERT INTO tasks ${sql.insert({
          id,
          owner_id: ALDRIC,
          root_id: id,
          brief: id,
          state: "active",
          created_at: NOW,
          updated_at: NOW,
        })}`;
        yield* sql`INSERT INTO quests ${sql.insert({
          id: `quest-${id}`,
          task_id: id,
          lead_id: ALDRIC,
          goal: id,
          acceptance: JSON.stringify(acceptance),
          limits: JSON.stringify(DEFAULT_QUEST_LIMITS),
          depth: 1,
          state: "active",
          created_at: NOW,
        })}`;
      }
      yield* questCriteria;
      return yield* sql<{
        readonly id: string;
        readonly criteria: string;
      }>`SELECT id, criteria FROM quests ORDER BY id`;
    }).pipe(Effect.provide(TestDatabaseAt(earlier)), Effect.scoped, Effect.runPromise);
    const criteria = Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.criteria)]));
    expect(criteria["quest-without"]).toEqual([]);
    expect(criteria["quest-with"]).toMatchObject([
      { text: "Copy approved", required: true, state: "open", taskIds: [], evidence: [], decided: null },
      { text: "Campaign built", required: true, state: "open", taskIds: [], evidence: [], decided: null },
    ]);
    const ids = criteria["quest-with"].map((each: { readonly id: string }) => each.id);
    expect(new Set(ids).size).toBe(2);
  });
});

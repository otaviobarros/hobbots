import { HobbotsRepository, TaskRepository } from "@hobbots/agents";
import { Agent, AgentId, Channel, ChannelId, DEFAULT_QUEST_LIMITS, QuestId, QuestionId, TaskId } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { HobbotsRepositoryLive, migrations, TaskRepositoryLive } from "../src/index.ts";
import dropQuestCriteria from "../src/migrations/20261115144147_drop_quest_criteria.ts";
import { TestDatabaseAt } from "../src/testing.ts";

// Issue #1588: a Quest's acceptance criteria are gone. The migration drops `quests.criteria` and the
// journaled `QuestCriteriaChanged` entries, and withdraws a waiver question still open, which would
// otherwise hold the Quest's Task open for a criterion that no longer exists. On SQLite and
// PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-15T10:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const CHANNEL = ChannelId.make("chat");
const TASK = TaskId.make("campaign");
const QUEST = QuestId.make("quest");

const earlier = Object.fromEntries(
  Object.entries(migrations).filter(([id]) => id !== "20261115144147_drop_quest_criteria"),
) as typeof migrations;

const criteria = [
  { id: "c-copy", text: "Copy approved", required: true, taskIds: [], state: "open", evidence: [], decided: null },
  {
    id: "c-date",
    text: "Date set",
    required: true,
    taskIds: [],
    state: "open",
    evidence: [],
    decided: null,
    waiverAsk: { questionId: "q-waive", reason: "No date yet", at: NOW },
  },
];

const upgraded = Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  const repo = yield* HobbotsRepository;
  const tasks = yield* TaskRepository;
  yield* repo.insertAgent(
    new Agent({
      id: ALDRIC,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: NOW,
    }),
  );
  yield* repo.upsertChannel(
    new Channel({ id: CHANNEL, ownerHobId: ALDRIC, title: "Campaign", createdAt: NOW, updatedAt: NOW }),
  );
  yield* tasks.createTask({
    task: {
      id: TASK,
      ownerId: ALDRIC,
      parentId: null,
      channelId: CHANNEL,
      brief: "A campaign",
      dependsOn: [],
      createdAt: NOW,
    },
    delegation: null,
    milestones: [],
  });
  yield* tasks.startQuest({
    id: QUEST,
    taskId: TASK,
    goal: "A campaign",
    acceptance: ["Copy approved", "Date set"],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: NOW,
  });
  // The lead's ask to waive a criterion, and a question of its own, both still open.
  for (const [id, text] of [
    ["q-waive", 'Waive "Date set"? No date yet'],
    ["q-own", "Which date?"],
  ] as const) {
    yield* tasks.askQuestion({ id: QuestionId.make(id), taskId: TASK, askerId: ALDRIC, text, createdAt: NOW });
  }
  yield* sql`UPDATE quests SET criteria = ${JSON.stringify(criteria)} WHERE id = ${QUEST}`;
  yield* sql`INSERT INTO event_journal ${sql.insert({
    sequence: 1_000_000,
    id: "criteria-changed",
    type: "QuestCriteriaChanged",
    schema_version: 1,
    occurred_at: NOW,
    payload: "{}",
  })}`;

  const needsYou = sql<{
    readonly needs_you: unknown;
  }>`SELECT needs_you FROM quest_summaries WHERE quest_id = ${QUEST}`;
  const before = Number((yield* needsYou)[0]?.needs_you);

  yield* dropQuestCriteria;

  const questions = yield* sql<{ readonly id: string; readonly state: string }>`SELECT id, state FROM questions
    ORDER BY id`;
  const journaled = yield* sql<{ readonly n: unknown }>`SELECT COUNT(*) AS n FROM event_journal
    WHERE type = 'QuestCriteriaChanged'`;
  const [quest] = yield* sql<Record<string, unknown>>`SELECT * FROM quests WHERE id = ${QUEST}`;
  return {
    questions,
    journaled: Number(journaled[0]?.n),
    quest,
    needsYou: [before, Number((yield* needsYou)[0]?.needs_you)],
  };
});

describe("dropping a Quest's criteria (#1588)", () => {
  it("withdraws an open waiver question and recounts its summary, keeps the acceptance and drops the criteria and their events (#1588)", async () => {
    const result = await upgraded.pipe(
      Effect.provide(
        Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive).pipe(Layer.provideMerge(TestDatabaseAt(earlier))),
      ),
      Effect.runPromise,
    );
    expect(result.questions).toEqual([
      { id: "q-own", state: "open" },
      { id: "q-waive", state: "withdrawn" },
    ]);
    // The Quest's summary no longer counts the withdrawn question as needing you.
    expect(result.needsYou).toEqual([2, 1]);
    expect(result.journaled).toBe(0);
    expect(result.quest).not.toHaveProperty("criteria");
    expect(JSON.parse(String(result.quest?.acceptance))).toEqual(["Copy approved", "Date set"]);
  });
});

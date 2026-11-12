import { HobbotsRepository } from "@hobbots/agents";
import { Agent, AgentId, AttemptState, QuestionState, QuestState, TaskState } from "@hobbots/domain";
import { Cause, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { HobbotsRepositoryLive, migrations } from "../src/index.ts";
import stateChecks, { STATES } from "../src/migrations/0046_state_checks.ts";
import { QUEST_STATES } from "../src/migrations/0110_quest_stops.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// A Task's, an Attempt's, a Quest's and a question's state column refuses any state outside the
// domain's (#683), on SQLite and PostgreSQL (STD-TEST-006).

const at = "2026-11-04T00:00:00.000Z";

const agent = new Agent({
  id: AgentId.make("frodo"),
  name: "Frodo",
  roleTitle: "Lead",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 1,
  lookColor: "moss",
  configVersion: 1,
  createdAt: at,
});

// Keeps 0047, 0076, 0079, 0080, 0082 and 0083 too: the repository that seeds the hob writes its name with
// each version, its Charms, whether other hobs see it, its good at and who made and summoned it, and its Summoning scope.
const migrationsBefore = (id: string) =>
  Object.fromEntries(
    Object.entries(migrations).filter(
      ([key]) =>
        key < id ||
        [
          "0047_versioned_name",
          "0076_charm_grants",
          "0079_hob_visibility",
          "0080_hob_good_at",
          "0082_hob_actors",
          "0083_summoning",
        ].includes(key),
    ),
  ) as typeof migrations;

/** One row in each of the four tables, written as raw SQL so nothing but the database checks it. */
const seed = (taskState = "active") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* HobbotsRepository).insertAgent(agent);
    yield* sql`INSERT INTO tasks ${sql.insert({
      id: "top",
      ownerId: "frodo",
      rootId: "top",
      brief: "Build it",
      state: taskState,
      createdAt: at,
      updatedAt: at,
    })}`;
    yield* sql`INSERT INTO quests ${sql.insert({
      id: "quest",
      taskId: "top",
      leadId: "frodo",
      goal: "Build it",
      limits: "{}",
      depth: 1,
      state: "active",
      createdAt: at,
    })}`;
    yield* sql`INSERT INTO attempts ${sql.insert({
      id: "attempt",
      taskId: "top",
      number: 1,
      agentId: "frodo",
      runtime: "claude-code",
      configVersion: 1,
      state: "running",
      startedAt: at,
    })}`;
    yield* sql`INSERT INTO questions ${sql.insert({
      id: "question",
      taskId: "top",
      askerId: "frodo",
      text: "Dark or light?",
      state: "open",
      createdAt: at,
    })}`;
  });

/** Whether the database takes `state` for the row of `table`. */
const takes = (table: string, id: string, state: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe(`UPDATE ${table} SET state = '${state}' WHERE id = '${id}'`).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  });

const ROWS = [
  { table: "tasks", id: "top", states: TaskState.literals },
  { table: "attempts", id: "attempt", states: AttemptState.literals },
  { table: "quests", id: "quest", states: QuestState.literals },
  { table: "questions", id: "question", states: QuestionState.literals },
] as const;

describe("0046_state_checks", () => {
  // covers DP-003
  it("[TC-DP-221] lists every state the domain has, so a new state needs a migration of its own", () => {
    // 0110 let a Quest be stopping and stopped (#1346).
    expect({ ...STATES, quests: QUEST_STATES }).toEqual({
      tasks: TaskState.literals,
      attempts: AttemptState.literals,
      quests: QuestState.literals,
      questions: QuestionState.literals,
    });
  });

  // covers DP-003, OR-004
  it("[TC-DP-222] refuses a state outside the domain's in each state column, and takes every one inside it", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed();
      const taken: Record<string, ReadonlyArray<boolean>> = {};
      const refused: Record<string, boolean> = {};
      for (const { table, id, states } of ROWS) {
        const each: Array<boolean> = [];
        for (const state of states) each.push(yield* takes(table, id, state));
        taken[table] = each;
        refused[table] = !(yield* takes(table, id, "paused"));
      }
      // A new row with an unknown state is refused as well.
      const inserted = yield* sql`INSERT INTO tasks ${sql.insert({
        id: "stray",
        ownerId: "frodo",
        rootId: "stray",
        brief: "Stray",
        state: "paused",
        createdAt: at,
        updatedAt: at,
      })}`.pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      return { taken, refused, inserted };
    }).pipe(Effect.provide(HobbotsRepositoryLive.pipe(Layer.provideMerge(TestDatabase))), Effect.runPromise);

    for (const { table, states } of ROWS) expect(result.taken[table]).toEqual(states.map(() => true));
    expect(result.refused).toEqual({ tasks: true, attempts: true, quests: true, questions: true });
    expect(result.inserted).toBe(false);
  });

  // covers DP-003
  it("[TC-DP-223] stops on a stored row whose state is unknown, naming it", async () => {
    const exit = await Effect.gen(function* () {
      yield* seed("paused");
      return yield* stateChecks;
    }).pipe(
      Effect.provide(HobbotsRepositoryLive.pipe(Layer.provideMerge(TestDatabaseAt(migrationsBefore("0046"))))),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain('tasks top holds the state "paused"');
  });
});

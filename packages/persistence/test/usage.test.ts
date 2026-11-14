import { HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type AgentStatus,
  AttemptId,
  type HobUsage,
  Message,
  MessageId,
  type MessageStatus,
  OWNER_ACTOR,
  QuestId,
  type ReplyUsage,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, UsageLedger } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const created = "2026-10-01T00:00:00.000Z";

const hob = (id: string, status: AgentStatus = "active") =>
  new Agent({
    id: AgentId.make(id),
    name: id.charAt(0).toUpperCase() + id.slice(1),
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    status,
    createdAt: created,
  });

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0): ReplyUsage => ({
  timeToRequestMs: 5,
  timeToFirstStreamMs: 15,
  timeToFirstTokenMs: 20,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

let seq = 0;
const reply = (
  threadId: string,
  createdAt: string,
  usage: ReplyUsage | null,
  options: { status?: MessageStatus; model?: string | null; role?: "user" | "assistant" } = {},
) =>
  new Message({
    id: MessageId.make(`m${++seq}`),
    threadId: ThreadId.make(threadId),
    actor: options.role === "user" ? OWNER_ACTOR : null,
    role: options.role ?? "assistant",
    content: "…",
    status: options.status ?? "complete",
    error: null,
    configVersion: options.role === "user" ? null : 1,
    runtime: options.role === "user" ? null : "claude-code",
    model: options.model === undefined ? "sonnet" : options.model,
    usage,
    createdAt,
  });

// Pip and Bramble work in the period; Moss retired after replying in it. One of Pip's replies is
// from before the period, one failed without a report, one still streams and one is the user's.
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const agent of [hob("pip"), hob("bramble"), hob("moss", "retired")]) yield* repo.insertAgent(agent);
  for (const [id, agentId] of [
    ["t-pip", "pip"],
    ["t-bramble", "bramble"],
    ["t-moss", "moss"],
  ] as const) {
    yield* repo.upsertThread(
      new Thread({
        id: ThreadId.make(id),
        agentId: AgentId.make(agentId),
        title: id,
        createdAt: created,
        updatedAt: created,
      }),
    );
  }
  const messages = [
    reply("t-pip", "2026-10-20T09:00:00.000Z", tokens(10, 20)),
    reply("t-pip", "2026-10-28T09:15:00.000Z", tokens(100, 200, 1000, 0)),
    reply("t-pip", "2026-10-28T09:40:00.000Z", tokens(50, 50, 0, 500), { model: "opus" }),
    reply("t-pip", "2026-10-28T10:05:00.000Z", null, { status: "failed" }),
    reply("t-pip", "2026-10-28T10:06:00.000Z", null, { status: "streaming" }),
    reply("t-pip", "2026-10-28T10:07:00.000Z", null, { role: "user", model: null }),
    reply("t-bramble", "2026-10-29T15:00:00.000Z", tokens(5, 5)),
    reply("t-moss", "2026-10-30T23:59:00.000Z", tokens(1, 2, 3, 4)),
    // After the period ends.
    reply("t-bramble", "2026-11-01T00:00:00.000Z", tokens(9, 9)),
  ];
  for (const message of messages) yield* repo.upsertMessage(message);
});

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, UsageLedger.layer).pipe(Layer.provideMerge(TestDatabase));
const TasksLayer = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  EventJournal.layer,
  UsageLedger.layer,
).pipe(Layer.provideMerge(TestDatabase));

// Pip led a Quest in its chat from 09:30 to 10:00 on Oct 28, with Bramble in the party, and started a
// sub-quest under it at 09:35. Only Pip's 09:40 reply was written while the Quest ran.
const seedQuests = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-10-28T09:30:00.000Z";
  for (const [id, owner, parent] of [
    ["k-plan", "pip", null],
    ["k-draft", "bramble", "k-plan"],
    ["k-sub", "pip", "k-plan"],
  ] as const) {
    yield* sql`INSERT INTO tasks ${sql.insert({
      id,
      owner_id: owner,
      parent_id: parent,
      root_id: "k-plan",
      thread_id: "t-pip",
      brief: id,
      state: "active",
      created_at: at,
      updated_at: at,
    })}`;
  }
  for (const [id, task, parent, createdAt, endedAt] of [
    ["q-plan", "k-plan", null, at, "2026-10-28T10:00:00.000Z"],
    ["q-sub", "k-sub", "q-plan", "2026-10-28T09:35:00.000Z", null],
  ] as const) {
    yield* sql`INSERT INTO quests ${sql.insert({
      id,
      task_id: task,
      lead_id: "pip",
      parent_quest_id: parent,
      thread_id: "t-pip",
      goal: id === "q-plan" ? "Plan the week" : "Pick the days",
      limits: "{}",
      depth: parent === null ? 0 : 1,
      state: endedAt === null ? "active" : "completed",
      created_at: createdAt,
      ended_at: endedAt,
    })}`;
  }
}).pipe(Effect.orDie);

const run = <A>(effect: Effect.Effect<A, never, HobbotsRepository | UsageLedger | SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* seed;
    yield* seedQuests;
    return yield* effect;
  }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

/** Starts a haiku turn on the Attempt, and ends it with `usage` unless that is "open". */
const turn = (
  tasks: TaskRepository["Service"],
  attemptId: string,
  agentId: string,
  startedAt: string,
  usage: ReplyUsage | null | "open",
) =>
  Effect.gen(function* () {
    const counted = { attemptId: AttemptId.make(attemptId), startedAt };
    yield* tasks.startTurn({ ...counted, agentId: AgentId.make(agentId), runtime: "claude-code", model: "haiku" });
    if (usage !== "open") yield* tasks.endTurn(counted, usage, startedAt.replace(":00.000Z", ":30.000Z"));
  });

// Bramble's Task on Pip's Quest ran two turns at 09:45 on Oct 28, on Haiku: the second resumed the
// first and failed without a report. Moss ran a step of a Task outside any Quest that day.
const seedTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* HobbotsRepository;
  yield* repo.upsertThread(
    new Thread({
      id: ThreadId.make("t-moss-plan"),
      agentId: AgentId.make("moss"),
      title: "t-moss-plan",
      createdAt: created,
      updatedAt: created,
    }),
  );
  const at = "2026-10-28T09:45:00.000Z";
  yield* sql`INSERT INTO tasks ${sql.insert({
    id: "k-tidy",
    owner_id: "moss",
    parent_id: null,
    root_id: "k-tidy",
    thread_id: "t-moss-plan",
    brief: "k-tidy",
    state: "active",
    created_at: at,
    updated_at: at,
  })}`;
  for (const [id, task, agent] of [
    ["a-draft", "k-draft", "bramble"],
    ["a-tidy", "k-tidy", "moss"],
  ] as const) {
    yield* sql`INSERT INTO attempts ${sql.insert({
      id,
      task_id: task,
      number: 1,
      agent_id: agent,
      runtime: "claude-code",
      config_version: 1,
      state: "running",
      started_at: at,
    })}`;
  }
  const tasks = yield* TaskRepository;
  yield* turn(tasks, "a-draft", "bramble", at, tokens(40, 400, 4000, 0));
  // Recording a turn again changes nothing.
  yield* turn(tasks, "a-draft", "bramble", at, tokens(40, 400, 4000, 0));
  yield* turn(tasks, "a-draft", "bramble", "2026-10-28T09:50:00.000Z", null);
  yield* turn(tasks, "a-tidy", "moss", "2026-10-28T11:00:00.000Z", tokens(1, 1));
}).pipe(Effect.orDie);

describe("UsageLedger", () => {
  // regression for #1011: a party member's turns wrote no reply, so Usage left them out
  // covers OP-002
  it("[TC-OP-107] counts each turn outside a chat under its hob, and a party member's for its Quest", async () => {
    const { hobs, quests, minutes } = await Effect.gen(function* () {
      yield* seed;
      yield* seedQuests;
      yield* seedTurns;
      return yield* UsageLedger.use((ledger) => ledger.usage("2026-10-25T00:00:00.000Z", "2026-11-01T00:00:00.000Z"));
    }).pipe(Effect.provide(TasksLayer), Effect.scoped, Effect.runPromise);

    expect(hobs.filter((row) => row.model === "haiku")).toMatchObject([
      // Bramble's failed turn counts as one that reported nothing.
      { hobId: "bramble", replies: 2, unreported: 1, inputTokens: 40, outputTokens: 400, cacheReadTokens: 4000 },
      { hobId: "moss", replies: 1, unreported: 0, inputTokens: 1, outputTokens: 1 },
    ]);
    // Pip's Quest counts Bramble's turns with Pip's reply, in the one chat they were written in.
    expect(quests.find((row) => row.questId === "q-plan")).toMatchObject({
      party: 2,
      chats: 1,
      replies: 3,
      unreported: 1,
      tokens: 600 + 4440,
    });
    // Moss's step is outside any Quest.
    expect(quests.find((row) => row.questId === null)).toMatchObject({ chats: 3, replies: 5, tokens: 1322 });
    expect(minutes.find((row) => row.minute === "2026-10-28T09:45:00.000Z")).toEqual({
      minute: "2026-10-28T09:45:00.000Z",
      replies: 1,
      tokens: 4440,
    });
  });

  // covers OP-002, #1449
  it("[TC-OP-1449-04] sums what a Quest's whole party ever spent, a sub-quest's and turns outside a chat included", async () => {
    const spent = await Effect.gen(function* () {
      yield* seed;
      yield* seedQuests;
      yield* seedTurns;
      return yield* UsageLedger.use((ledger) =>
        Effect.all([ledger.spentOn(QuestId.make("q-plan")), ledger.spentOn(QuestId.make("q-none"))]),
      );
    }).pipe(Effect.provide(TasksLayer), Effect.scoped, Effect.runPromise);
    // The same replies and turns the Usage screen counts for it, from any time.
    expect(spent).toEqual([
      { tokens: 600 + 4440, turns: 3, unreported: 1 },
      { tokens: 0, turns: 0, unreported: 0 },
    ]);
  });

  // covers OP-002
  it("[TC-OP-070] sums each hob's settled replies in the period by runtime and model", async () => {
    const { hobs } = await run(
      UsageLedger.use((ledger) => ledger.usage("2026-10-25T00:00:00.000Z", "2026-11-01T00:00:00.000Z")),
    );
    const rows = hobs.map(
      ({ hobId, model, replies, unreported, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) => ({
        hobId,
        model,
        replies,
        unreported,
        tokens: [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens],
      }),
    );
    expect(rows).toEqual([
      { hobId: "bramble", model: "sonnet", replies: 1, unreported: 0, tokens: [5, 5, 0, 0] },
      { hobId: "moss", model: "sonnet", replies: 1, unreported: 0, tokens: [1, 2, 3, 4] },
      { hobId: "pip", model: "opus", replies: 1, unreported: 0, tokens: [50, 50, 0, 500] },
      // The failed reply counts, as one that reported nothing; the streaming one and the user's do not.
      { hobId: "pip", model: "sonnet", replies: 2, unreported: 1, tokens: [100, 200, 1000, 0] },
    ]);
    // A retired hob keeps its name and says it retired.
    expect(hobs.find((row) => row.hobId === "moss")).toMatchObject({
      hobName: "Moss",
      hobStatus: "retired",
      runtime: "claude-code",
    });
  });

  // regression for #1011: a turn the hub stopped before it ended was never recorded
  // covers OP-002
  it("[TC-OP-109] counts a turn the hub never saw end, as unreported, once a later turn or a restart ends it", async () => {
    const period = (ledger: UsageLedger["Service"]) =>
      ledger.usage("2026-10-25T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    const haiku = (hobs: ReadonlyArray<HobUsage>) =>
      hobs.filter((row) => row.model === "haiku").map(({ hobId, replies, unreported }) => [hobId, replies, unreported]);
    const { running, resumed, restarted } = await Effect.gen(function* () {
      yield* seed;
      yield* seedQuests;
      yield* seedTurns;
      const tasks = yield* TaskRepository;
      const ledger = yield* UsageLedger;
      // The hub stops mid-turn twice: in Bramble's third turn and in Moss's second.
      yield* turn(tasks, "a-draft", "bramble", "2026-10-28T09:55:00.000Z", "open");
      yield* turn(tasks, "a-tidy", "moss", "2026-10-28T11:05:00.000Z", "open");
      const running = haiku((yield* period(ledger)).hobs);
      // Bramble's Attempt resumes after the restart: its next turn ends the one left open.
      yield* turn(tasks, "a-draft", "bramble", "2026-10-28T10:00:00.000Z", "open");
      const resumed = haiku((yield* period(ledger)).hobs);
      // Moss's Attempt ends as the restart ends every Attempt left live.
      yield* tasks.updateAttempt(AttemptId.make("a-tidy"), {
        _tag: "Ended",
        end: { _tag: "Stopped", reason: "Hobbots stopped while this ran." },
        at: "2026-10-28T12:00:00.000Z",
      });
      const restarted = haiku((yield* period(ledger)).hobs);
      return { running, resumed, restarted };
    }).pipe(Effect.provide(TasksLayer), Effect.scoped, Effect.runPromise);

    // A turn of a live Attempt still running has not reported yet.
    expect(running).toEqual([
      ["bramble", 2, 1],
      ["moss", 1, 0],
    ]);
    expect(resumed).toEqual([
      ["bramble", 3, 2],
      ["moss", 1, 0],
    ]);
    expect(restarted).toEqual([
      ["bramble", 3, 2],
      ["moss", 2, 1],
    ]);
  });

  // covers OP-002
  it("[TC-OP-071] counts the period's replies and tokens by the minute they started, in UTC", async () => {
    // A minute, not an hour, so a reader in a time zone a half or quarter hour off UTC gets its own days.
    const { minutes } = await run(
      UsageLedger.use((ledger) => ledger.usage("2026-10-25T00:00:00.000Z", "2026-11-01T00:00:00.000Z")),
    );
    expect(minutes).toEqual([
      { minute: "2026-10-28T09:15:00.000Z", replies: 1, tokens: 1300 },
      { minute: "2026-10-28T09:40:00.000Z", replies: 1, tokens: 600 },
      { minute: "2026-10-28T10:05:00.000Z", replies: 1, tokens: 0 },
      { minute: "2026-10-29T15:00:00.000Z", replies: 1, tokens: 10 },
      { minute: "2026-10-30T23:59:00.000Z", replies: 1, tokens: 10 },
    ]);
  });

  // covers OP-002
  it("[TC-OP-090] sums the period's replies by the Quest whose chat they were written in while it ran", async () => {
    const { quests } = await run(
      UsageLedger.use((ledger) => ledger.usage("2026-10-25T00:00:00.000Z", "2026-11-01T00:00:00.000Z")),
    );
    expect(quests).toEqual([
      // Every reply outside a Quest's run, in three chats, the failed one unreported.
      { questId: null, goal: null, leadName: null, party: 0, chats: 3, replies: 4, unreported: 1, tokens: 1320 },
      // The reply under the sub-quest counts for the Quest at the top, whose party is Pip and Bramble.
      {
        questId: "q-plan",
        goal: "Plan the week",
        leadName: "Pip",
        party: 2,
        chats: 1,
        replies: 1,
        unreported: 0,
        tokens: 600,
      },
    ]);
  });
});

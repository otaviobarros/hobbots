import { HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type AgentStatus,
  Message,
  MessageId,
  type MessageStatus,
  type ReplyUsage,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { HobbotsRepositoryLive, UsageLedger } from "../src/index.ts";
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

describe("UsageLedger", () => {
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

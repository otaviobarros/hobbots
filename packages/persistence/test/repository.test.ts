import { Agent, AgentId, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { HobbotsRepository } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = HobbotsRepository.layer.pipe(Layer.provide(TestDatabase));
const now = "2026-10-28T00:00:00.000Z";
const agentId = AgentId.make("aldric");
const threadId = ThreadId.make("t1");

const message = (id: string, status: Message["status"] = "complete") =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role: "assistant",
    content: id,
    status,
    error: null,
    createdAt: now,
  });

describe("HobbotsRepository", () => {
  // covers DP-003, CH-002
  it("[TC-DP-004] round-trips agents, threads and ordered messages", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          craft: "Guide",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 1234,
          lookColor: "moss",
          createdAt: now,
        }),
      );
      yield* repo.upsertThread(
        new Thread({
          id: threadId,
          agentId,
          title: "New thread",
          runtimeSessionId: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* repo.upsertThread(
        new Thread({
          id: threadId,
          agentId,
          title: "Renamed",
          runtimeSessionId: "s1",
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* repo.upsertMessage(message("b"));
      yield* repo.upsertMessage(message("a", "streaming"));
      yield* repo.upsertMessage(new Message({ ...message("b"), content: "b2" }));
      const interrupted = yield* repo.interruptStaleMessages;
      return {
        agents: yield* repo.listAgents,
        thread: yield* repo.findThread(threadId),
        messages: yield* repo.listMessages(threadId),
        interrupted,
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.agents.map((a) => [a.name, a.lookSeed, a.lookColor])).toEqual([["Aldric", 1234, "moss"]]);
    expect(Option.getOrThrow(result.thread)).toMatchObject({
      title: "Renamed",
      runtimeSessionId: "s1",
    });
    expect(result.messages.map((m) => [m.id, m.content, m.status])).toEqual([
      ["b", "b2", "complete"],
      ["a", "a", "interrupted"],
    ]);
    expect(result.interrupted.map((m) => m.id)).toEqual(["a"]);
  });

  // covers DP-003, AG-001
  it("[TC-DP-002] stores the full look seed range and orders ties the same on every database", async () => {
    const agent = (id: string, lookSeed: number) =>
      new Agent({
        id: AgentId.make(id),
        name: id,
        craft: "Guide",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed,
        lookColor: "violet",
        createdAt: now,
      });
    const thread = (id: string) =>
      new Thread({ id: ThreadId.make(id), agentId, title: id, runtimeSessionId: null, createdAt: now, updatedAt: now });

    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      // Inserted out of id order, with equal timestamps and ids whose order depends on collation.
      for (const [id, seed] of [
        ["b", 2 ** 32 - 1],
        ["B", 0],
        [agentId, 2 ** 31],
        ["a-c", 7],
        ["ab", 8],
      ] as const) {
        yield* repo.insertAgent(agent(id, seed));
      }
      for (const id of ["t-b", "T-a", "t-a", "ta"]) yield* repo.upsertThread(thread(id));
      return {
        agents: yield* repo.listAgents,
        threads: yield* repo.listThreads(agentId),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    // Ties fall back to the id, compared byte by byte (uppercase before lowercase, "-" before letters).
    expect(result.agents.map((a) => [a.id, a.lookSeed])).toEqual([
      ["B", 0],
      ["a-c", 7],
      ["ab", 8],
      ["aldric", 2 ** 31],
      ["b", 2 ** 32 - 1],
    ]);
    expect(result.threads.map((t) => t.id)).toEqual(["T-a", "t-a", "t-b", "ta"]);
  });
});

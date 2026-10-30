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
    configVersion: 1,
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
          configVersion: 1,
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
        configVersion: 1,
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
      // A second insert with a taken id changes nothing.
      const reinserted = yield* repo.insertAgent(agent("b", 5));
      for (const id of ["t-b", "T-a", "t-a", "ta"]) yield* repo.upsertThread(thread(id));
      return {
        reinserted,
        agents: yield* repo.listAgents,
        threads: yield* repo.listThreads(agentId),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.reinserted).toBe(false);
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

  // covers AG-002, DP-003
  it("[TC-AG-021] keeps every configuration version and stores an edit only on top of the current one", async () => {
    const first = new Agent({
      id: agentId,
      name: "Aldric",
      craft: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "Be brief.",
      lookSeed: 2 ** 32 - 1,
      lookColor: "violet",
      configVersion: 1,
      createdAt: now,
    });
    const second = new Agent({ ...first, instructions: "Be thorough.", effort: "high", configVersion: 2 });

    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(first);
      const updated = yield* repo.updateAgentConfig(second);
      // Another edit also based on version 1 arrives after version 2 is stored.
      const stale = yield* repo.updateAgentConfig(new Agent({ ...first, craft: "Scribe", configVersion: 2 }));
      return {
        updated,
        stale,
        agent: yield* repo.findAgent(agentId),
        v1: yield* repo.findAgentConfig(agentId, 1),
        v2: yield* repo.findAgentConfig(agentId, 2),
        v3: yield* repo.findAgentConfig(agentId, 3),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect([result.updated, result.stale]).toEqual([true, false]);
    expect(Option.getOrThrow(result.agent)).toEqual(second);
    expect(Option.getOrThrow(result.v1)).toMatchObject({
      version: 1,
      craft: "Guide",
      instructions: "Be brief.",
      effort: null,
      lookSeed: 2 ** 32 - 1,
    });
    expect(Option.getOrThrow(result.v2)).toMatchObject({ version: 2, craft: "Guide", instructions: "Be thorough." });
    expect(Option.isNone(result.v3)).toBe(true);
  });

  // covers AG-006, DP-003
  it("[TC-AG-035] stores a hob's lifecycle status, refuses a change from a stale status and lists hobs by status", async () => {
    const agent = (id: string, status?: "active" | "paused" | "retired") =>
      new Agent({
        id: AgentId.make(id),
        name: id,
        craft: "Guide",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "violet",
        configVersion: 1,
        createdAt: now,
        ...(status ? { status } : {}),
      });

    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(agent("a"));
      yield* repo.insertAgent(agent("b", "paused"));
      yield* repo.insertAgent(agent("c"));
      const retired = yield* repo.setAgentStatus(AgentId.make("c"), "active", "retired");
      // A wake computed from an earlier read of "paused" must not undo the retirement.
      const staleWake = yield* repo.setAgentStatus(AgentId.make("c"), "paused", "active");
      const ids = (statuses: ReadonlyArray<"active" | "paused" | "retired">) =>
        repo.listAgentsWithStatus(statuses).pipe(Effect.map((agents) => agents.map((a) => [a.id, a.status])));
      return {
        retired,
        staleWake,
        current: yield* ids(["active", "paused"]),
        archived: yield* ids(["retired"]),
        none: yield* ids([]),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect([result.retired, result.staleWake]).toEqual([true, false]);
    expect(result.current).toEqual([
      ["a", "active"],
      ["b", "paused"],
    ]);
    expect(result.archived).toEqual([["c", "retired"]]);
    expect(result.none).toEqual([]);
  });
});

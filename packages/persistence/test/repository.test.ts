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
  // covers CH-001, CH-002, DP-003
  it("[TC-DP-003] round-trips agents, threads and ordered messages", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          role: "Guide",
          runtime: "claude-code",
          model: null,
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
});

import { ApprovalRepository, HobbotsRepository } from "@hobbots/agents";
import { Agent, AgentId, ApprovalId, ApprovalRequest, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { ApprovalRepositoryLive, HobbotsRepositoryLive } from "@hobbots/persistence";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, ApprovalRepositoryLive).pipe(Layer.provide(TestDatabase));
const now = "2026-10-31T00:00:00.000Z";
const agentId = AgentId.make("aldric");
const threadId = ThreadId.make("t1");
const messageId = MessageId.make("m1");

const request = (id: string, onceOnly = false) =>
  new ApprovalRequest({
    id: ApprovalId.make(id),
    agentId,
    threadId,
    messageId,
    stepId: "tool-1",
    tool: "Bash",
    operation: "push",
    targets: ["origin main"],
    arguments: { command: "git push origin main", nested: { b: 1, a: [true, null] } },
    label: "Running git push origin main",
    reason: "Pushing asks first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1-0123456789abcdef",
    onceOnly,
    state: "pending",
    denyReason: null,
    createdAt: now,
    decidedAt: null,
  });

describe("ApprovalRepository", () => {
  // covers PE-003, PE-007
  it("[TC-PE-070] stores a request with its exact action and moves it out of pending only once", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const approvals = yield* ApprovalRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          roleTitle: "Guide",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 1,
          lookColor: "moss",
          configVersion: 1,
          createdAt: now,
        }),
      );
      yield* repo.upsertThread(
        new Thread({ id: threadId, agentId, title: "t", runtimeSessionId: null, createdAt: now, updatedAt: now }),
      );
      yield* repo.upsertMessage(
        new Message({
          id: messageId,
          threadId,
          role: "assistant",
          content: "",
          status: "streaming",
          error: null,
          configVersion: 1,
          createdAt: now,
        }),
      );
      const inserted = yield* approvals.insert(request("a1", true));
      yield* approvals.insert(request("a2"));
      const approved = new ApprovalRequest({ ...inserted.value, state: "approved", decidedAt: now });
      const first = yield* approvals.resolve(approved, "pending");
      const second = yield* approvals.resolve(
        new ApprovalRequest({ ...inserted.value, state: "denied", denyReason: "no", decidedAt: now }),
        "pending",
      );
      return {
        inserted,
        first,
        second,
        found: yield* approvals.find(ApprovalId.make("a1")),
        thread: yield* approvals.listForThread(threadId),
        pending: yield* approvals.listPending,
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.inserted.entries.map((e) => e.type)).toEqual(["ApprovalRequested"]);
    expect(result.inserted.entries[0]?.correlation).toEqual({ agentId, threadId, messageId });
    expect(Option.getOrThrow(result.first).entries.map((e) => e.type)).toEqual(["ApprovalResolved"]);
    expect(Option.isNone(result.second)).toBe(true);
    const found = Option.getOrThrow(result.found);
    expect(found.state).toBe("approved");
    expect(found.arguments).toEqual({ command: "git push origin main", nested: { b: 1, a: [true, null] } });
    expect(found.targets).toEqual(["origin main"]);
    expect(found.onceOnly).toBe(true);
    expect(found.revision).toBe(Option.getOrThrow(result.first).value.revision);
    expect(result.thread.map((a) => [a.id, a.onceOnly])).toEqual([
      ["a1", true],
      ["a2", false],
    ]);
    expect(result.pending.map((a) => a.id)).toEqual(["a2"]);
  });
});

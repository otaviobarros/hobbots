import { ApprovalRepository, GrantRepository, HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  Grant,
  GrantId,
  Message,
  MessageId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { ApprovalRepositoryLive, GrantRepositoryLive, HobbotsRepositoryLive } from "@hobbots/persistence";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, ApprovalRepositoryLive, GrantRepositoryLive).pipe(
  Layer.provide(TestDatabase),
);
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

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
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
  yield* repo.upsertThread(new Thread({ id: threadId, agentId, title: "t", createdAt: now, updatedAt: now }));
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
});

describe("ApprovalRepository", () => {
  // covers PE-003, PE-007
  it("[TC-PE-070] stores a request with its exact action and moves it out of pending only once", async () => {
    const result = await Effect.gen(function* () {
      const approvals = yield* ApprovalRepository;
      yield* seed;
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

describe("ApprovalRepository.listRecent", () => {
  // covers PE-003, UX-005
  it("[TC-IN-001] lists every pending request and only the most recent closed ones, oldest first", async () => {
    const at = (minute: number) => `2026-10-31T00:${String(minute).padStart(2, "0")}:00.000Z`;
    const listed = await Effect.gen(function* () {
      const approvals = yield* ApprovalRepository;
      yield* seed;
      // An old pending request stays listed however many closed ones came after it.
      yield* approvals.insert(new ApprovalRequest({ ...request("p-old"), createdAt: at(1) }));
      for (const minute of [2, 3, 4, 5]) {
        const inserted = yield* approvals.insert(
          new ApprovalRequest({ ...request(`c${minute}`), createdAt: at(minute) }),
        );
        yield* approvals.resolve(
          new ApprovalRequest({ ...inserted.value, state: minute % 2 === 0 ? "expired" : "denied", decidedAt: at(9) }),
          "pending",
        );
      }
      yield* approvals.insert(new ApprovalRequest({ ...request("p-new"), createdAt: at(6) }));
      return yield* approvals.listRecent(2);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(listed.map((a) => [a.id, a.state])).toEqual([
      ["p-old", "pending"],
      ["c4", "expired"],
      ["c5", "denied"],
      ["p-new", "pending"],
    ]);
  });
});

const grantFor = (approvalId: string, id: string) =>
  new Grant({
    id: GrantId.make(id),
    agentId,
    operation: "push",
    rule: { _tag: "Push", cwd: "/work", remote: "origin", branch: "feature" },
    lifetime: "always",
    questId: null,
    approvalId: ApprovalId.make(approvalId),
    grantedBy: "user",
    createdAt: now,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
  });

describe("GrantRepository", () => {
  // covers PE-007, PE-008
  it("[TC-PE-096] saves a decision's grants in its transaction, once, and revokes each only once", async () => {
    const result = await Effect.gen(function* () {
      const approvals = yield* ApprovalRepository;
      const grants = yield* GrantRepository;
      yield* seed;
      const inserted = yield* approvals.insert(
        new ApprovalRequest({
          ...request("a1"),
          grantable: true,
          rules: [grantFor("a1", "g").rule],
          expiresAt: "2026-11-01T00:00:00.000Z",
        }),
      );
      const approved = new ApprovalRequest({
        ...inserted.value,
        state: "approved",
        lifetime: "always",
        decidedAt: now,
      });
      const first = yield* approvals.resolve(approved, "pending", [grantFor("a1", "g1")]);
      // A second decision that lost the race saves nothing, its grants included.
      const second = yield* approvals.resolve(approved, "pending", [grantFor("a1", "g2")]);
      const saved = yield* grants.forApproval(ApprovalId.make("a1"));
      yield* grants.touch([GrantId.make("g1")], "2026-10-31T01:00:00.000Z");
      const revoke = new Grant({
        ...(saved[0] as Grant),
        revokedAt: "2026-10-31T02:00:00.000Z",
        revokedBy: "user",
        revokeReason: "removed",
      });
      const revoked = yield* grants.revoke(revoke);
      const revokedAgain = yield* grants.revoke(revoke);
      return {
        first,
        second,
        saved,
        revoked,
        revokedAgain,
        request: yield* approvals.find(ApprovalId.make("a1")),
        all: yield* grants.list(agentId),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(Option.getOrThrow(result.first).entries.map((e) => e.type)).toEqual(["ApprovalResolved", "GrantCreated"]);
    expect(Option.getOrThrow(result.first).entries[1]?.correlation.agentId).toBe(agentId);
    expect(Option.isNone(result.second)).toBe(true);
    expect(result.saved.map((g) => g.id)).toEqual(["g1"]);
    expect(result.saved[0]?.rule).toEqual({ _tag: "Push", cwd: "/work", remote: "origin", branch: "feature" });
    expect(Option.getOrThrow(result.request)).toMatchObject({
      grantable: true,
      lifetime: "always",
      expiresAt: "2026-11-01T00:00:00.000Z",
      rules: [{ _tag: "Push" }],
    });
    expect(Option.getOrThrow(result.revoked).entries.map((e) => e.type)).toEqual(["GrantRevoked"]);
    expect(Option.isNone(result.revokedAgain)).toBe(true);
    expect(result.all).toHaveLength(1);
    expect(result.all[0]).toMatchObject({
      lastUsedAt: "2026-10-31T01:00:00.000Z",
      revokedBy: "user",
      revokeReason: "removed",
    });
  });
});

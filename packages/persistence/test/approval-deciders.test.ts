import { ApprovalRepository, HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  DeviceId,
  Message,
  MessageId,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { ApprovalRepositoryLive, HobbotsRepositoryLive } from "@hobbots/persistence";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import approvalDeciders from "../src/migrations/0040_approval_deciders.ts";
import { migrations } from "../src/migrations/index.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Who decided each approval request (#598): the approved device and where, stored with the decision.
const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, ApprovalRepositoryLive).pipe(Layer.provide(TestDatabase));
const now = "2026-11-03T01:17:52.000Z";
const later = "2026-11-03T01:18:27.000Z";
const agentId = AgentId.make("nettle");
const threadId = ThreadId.make("t1");
const messageId = MessageId.make("m1");
const PHONE = DeviceId.make("phone");

const request = (id: string) =>
  new ApprovalRequest({
    id: ApprovalId.make(id),
    agentId,
    threadId,
    messageId,
    stepId: "tool-1",
    tool: "Bash",
    operation: "delete-files",
    targets: ["scratch/tmp-notes.txt"],
    arguments: { command: "rm scratch/tmp-notes.txt" },
    label: "Running rm scratch/tmp-notes.txt",
    reason: "Deleting files asks first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1-0123456789abcdef",
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
      name: "Nettle",
      roleTitle: "Writer",
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

describe("ApprovalRepository deciders", () => {
  // covers PE-003
  it("[TC-IN-200] stores the device and the surface a request was decided from, and reads them back", async () => {
    const result = await Effect.gen(function* () {
      const approvals = yield* ApprovalRepository;
      yield* seed;
      const inserted = yield* approvals.insert(request("a1"));
      yield* approvals.resolve(
        new ApprovalRequest({
          ...inserted.value,
          state: "approved",
          lifetime: "once",
          decidedAt: later,
          decidedByDeviceId: PHONE,
          decidedVia: "inbox",
        }),
        "pending",
      );
      return {
        inserted: inserted.value,
        found: Option.getOrThrow(yield* approvals.find(ApprovalId.make("a1"))),
        recent: yield* approvals.listRecent(10),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.inserted).toMatchObject({ decidedByDeviceId: null, decidedVia: null });
    expect(result.found).toMatchObject({ state: "approved", decidedByDeviceId: PHONE, decidedVia: "inbox" });
    expect(result.recent.map((a) => [a.decidedByDeviceId, a.decidedVia])).toEqual([[PHONE, "inbox"]]);
  });

  // covers PE-003
  it("[TC-IN-201] keeps the first decider when a request is decided twice, and records an expiry with no decider", async () => {
    const result = await Effect.gen(function* () {
      const approvals = yield* ApprovalRepository;
      yield* seed;
      const first = (yield* approvals.insert(request("a1"))).value;
      const second = (yield* approvals.insert(request("a2"))).value;
      const decided = (device: DeviceId, via: "chat" | "inbox") =>
        new ApprovalRequest({
          ...first,
          state: "denied",
          decidedAt: later,
          decidedByDeviceId: device,
          decidedVia: via,
        });
      const once = yield* approvals.resolve(decided(WINDOW_DEVICE_ID, "chat"), "pending");
      const twice = yield* approvals.resolve(decided(PHONE, "inbox"), "pending");
      yield* approvals.resolve(
        new ApprovalRequest({ ...second, state: "expired", decidedAt: later, decidedVia: "expired" }),
        "pending",
      );
      return {
        once,
        twice,
        first: Option.getOrThrow(yield* approvals.find(first.id)),
        second: Option.getOrThrow(yield* approvals.find(second.id)),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(Option.isSome(result.once)).toBe(true);
    expect(Option.isNone(result.twice)).toBe(true);
    expect(result.first).toMatchObject({ decidedByDeviceId: WINDOW_DEVICE_ID, decidedVia: "chat" });
    expect(result.second).toMatchObject({ state: "expired", decidedByDeviceId: null, decidedVia: "expired" });
  });
});

describe("0040_approval_deciders", () => {
  // covers DP-003, PE-003
  it("[TC-IN-202] keeps every request closed before it, with no decider recorded", async () => {
    // Keeps 0047, 0049, 0051, 0053, 0062, 0067, 0068, 0076, 0079 and 0080 too: the repository that seeds
    // the hob writes its name with each version, its Charms, whether other hobs see it and its good at,
    // seeds the thread with its pin,
    // writes the reply with the prompt it answers, whether it is quiet, its skills and the ones it used,
    // and reads the thread with how far you read it.
    const kept = new Set([
      "0047_versioned_name",
      "0049_thread_pinned_at",
      "0051_steer_receipts",
      "0053_thread_reads",
      "0062_quiet_replies",
      "0067_message_skills",
      "0068_message_skills_used",
      "0076_charm_grants",
      "0079_hob_visibility",
      "0080_hob_good_at",
    ]);
    const earlier = Object.fromEntries(
      Object.entries(migrations).filter(([key]) => key < "0040" || kept.has(key)),
    ) as typeof migrations;
    const found = await Effect.gen(function* () {
      const approvals = yield* ApprovalRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* sql`INSERT INTO approval_requests ${sql.insert({
        id: "a1",
        agent_id: agentId,
        thread_id: threadId,
        message_id: messageId,
        step_id: "tool-1",
        tool: "Bash",
        operation: "delete-files",
        targets: JSON.stringify(["scratch/tmp-notes.txt"]),
        arguments: JSON.stringify({ command: "rm scratch/tmp-notes.txt" }),
        label: "Running rm scratch/tmp-notes.txt",
        reason: "Deleting files asks first.",
        action_digest: "d".repeat(64),
        policy_version: "r1-0123456789abcdef",
        state: "approved",
        lifetime: "once",
        created_at: now,
        decided_at: later,
      })}`;
      yield* approvalDeciders;
      return Option.getOrThrow(yield* approvals.find(ApprovalId.make("a1")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(HobbotsRepositoryLive, ApprovalRepositoryLive).pipe(Layer.provideMerge(TestDatabaseAt(earlier))),
      ),
      Effect.runPromise,
    );

    expect(found).toMatchObject({ state: "approved", decidedAt: later, decidedByDeviceId: null, decidedVia: null });
  });
});

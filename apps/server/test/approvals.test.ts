import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalRepository,
  ApprovalService,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type ToolAccess,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type ApprovalRequest,
  EMPTY_HOB_POLICY,
  isInProgress,
  type Message,
  type ReplyStep,
  type ThreadId,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { ApprovalRepositoryLive, HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Exit, Fiber, Layer, PubSub, Schedule, type Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { type BusEvent, EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("aldric");
const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-approvals-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const folder = join(root, "work");
mkdirSync(folder);

const summonHob = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "You are Aldric.",
      lookSeed: 4821,
      lookColor: "violet",
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

// Balanced: pushing asks. Each test may narrow the policy while a turn waits.
let restrictions: ToolAccess["policy"]["restrictions"] = [];
const tools = Layer.succeed(
  HobTools,
  HobTools.of({
    access: () =>
      Effect.sync(() => ({
        policy: {
          preset: "balanced",
          sharedFolders: [folder],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(root, "data"),
          restrictions,
        },
        folders: [folder],
        runtimeFolder: join(root, "runtimes", HOB_ID),
      })),
  }),
);

const Persistence = Layer.mergeAll(HobbotsRepositoryLive, ApprovalRepositoryLive).pipe(
  Layer.provideMerge(TestDatabase),
);
const TestLayer = HobLifecycle.layer.pipe(
  Layer.provideMerge(ChatService.layer.pipe(Layer.provide(tools))),
  Layer.provideMerge(ApprovalService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(Persistence)),
      EventBus.layer,
      // The decisions these cases make are the user's, as the hub's user-session middleware provides.
      Layer.succeed(UserSession, { origin: "http://localhost:4317" }),
      HobAdmission.layer,
      FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
    ),
  ),
);

// A push to a feature branch asks; one to the default branch is high risk and needs confirming.
const PUSH = "Ship it\nfake:tool Bash git push origin feature";
const PROTECTED_PUSH = "Ship it\nfake:tool Bash git push origin main";

/** Sends the prompt and waits until its tool call waits for a decision. */
const askInNewThread = (prompt = PUSH) =>
  Effect.gen(function* () {
    const chat = yield* ChatService;
    const thread = yield* chat.createThread(HOB_ID);
    yield* chat.sendPrompt(thread.id, prompt);
    const pending = yield* pendingIn(thread.id);
    return { thread, pending };
  });

const pendingIn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const approvals = yield* ApprovalService;
    return yield* approvals.listForThread(threadId).pipe(
      Effect.flatMap((all) => {
        const pending = all.filter((a) => a.state === "pending");
        return pending.length > 0
          ? Effect.succeed(pending as ReadonlyArray<ApprovalRequest>)
          : Effect.fail("none" as const);
      }),
      Effect.retry(Schedule.spaced("5 millis")),
    );
  });

const reply = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    return (yield* repo.listMessages(threadId)).at(-1) as Message;
  });

const settled = (threadId: ThreadId) =>
  reply(threadId).pipe(
    Effect.flatMap((message) =>
      message.role === "assistant" && !isInProgress(message.status)
        ? Effect.succeed(message)
        : Effect.fail("busy" as const),
    ),
    Effect.retry(Schedule.spaced("5 millis")),
  );

/** Each saved version of the reply's tool steps, in order. */
const toolSteps = (events: ReadonlyArray<BusEvent>): ReadonlyArray<ReplyStep> =>
  events.flatMap((event) =>
    event._tag === "Journaled" &&
    event.entry.payload._tag === "MessageUpserted" &&
    event.entry.payload.message.role === "assistant"
      ? event.entry.payload.message.steps.filter((step) => step.kind === "tool")
      : [],
  );

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ApprovalService | ChatService | HobLifecycle | HobbotsRepository | EventBus | UserSession | Scope.Scope
  >,
) => effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

describe("Ask decisions", () => {
  // covers PE-003
  it("[TC-PE-060] pauses the turn on an Ask action until the user approves it, then runs it", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const bus = yield* EventBus;
        const subscription = yield* bus.subscribe;
        const { thread, pending } = yield* askInNewThread();
        // Still waiting a while later: nothing decided for the user.
        yield* Effect.sleep("100 millis");
        const waiting = yield* reply(thread.id);
        const request = pending[0] as ApprovalRequest;
        const approved = yield* approvals.decide(request.id, {
          decision: "approve",
          actionDigest: request.actionDigest,
        });
        const done = yield* settled(thread.id);
        const events = yield* PubSub.takeAll(subscription);
        return { request, waiting, approved, done, events };
      }),
    );

    expect(result.request).toMatchObject({
      agentId: HOB_ID,
      tool: "Bash",
      operation: "push",
      arguments: { command: "git push origin feature" },
      label: "Running git push origin feature",
      state: "pending",
      onceOnly: false,
    });
    expect(result.request.actionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.request.policyVersion).toMatch(/^r\d+-/);
    expect(result.waiting.status).toBe("streaming");
    expect(result.approved.state).toBe("approved");
    expect(result.done.status).toBe("complete");
    const journaled = result.events.flatMap((e) => (e._tag === "Journaled" ? [e.entry.type] : []));
    expect(journaled.filter((type) => type.startsWith("Approval"))).toEqual(["ApprovalRequested", "ApprovalResolved"]);
    const steps = toolSteps(result.events);
    // The step waits on the request, then runs once approved.
    expect(steps.find((step) => step.state === "awaiting")).toMatchObject({
      id: "fake-tool-1",
      approvalId: result.request.id,
    });
    expect(steps.at(-1)).toMatchObject({ id: "fake-tool-1", label: "Running git push origin feature", state: "done" });
  });

  // covers PE-007
  it("[TC-PE-077] approves a high-risk push only with the user's confirmation", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const { thread, pending } = yield* askInNewThread(PROTECTED_PUSH);
        const request = pending[0] as ApprovalRequest;
        const unconfirmed = yield* Effect.exit(
          approvals.decide(request.id, { decision: "approve", actionDigest: request.actionDigest }),
        );
        const stillWaiting = yield* pendingIn(thread.id);
        const approved = yield* approvals.decide(request.id, {
          decision: "approve",
          actionDigest: request.actionDigest,
          confirmed: true,
        });
        const done = yield* settled(thread.id);
        return { request, unconfirmed, stillWaiting, approved, done };
      }),
    );

    expect(result.request).toMatchObject({ onceOnly: true, state: "pending" });
    expect(Exit.isFailure(result.unconfirmed) && JSON.stringify(result.unconfirmed.cause)).toContain(
      "ApprovalNotConfirmed",
    );
    expect(result.stillWaiting.map((a) => a.id)).toEqual([result.request.id]);
    expect(result.approved.state).toBe("approved");
    expect(result.done.status).toBe("complete");
    expect(result.done.steps.at(-1)).toMatchObject({ state: "done" });
  });

  // covers PE-003, PE-007
  it("[TC-PE-061] runs the action once when it is approved twice", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const bus = yield* EventBus;
        const subscription = yield* bus.subscribe;
        const { thread, pending } = yield* askInNewThread();
        const request = pending[0] as ApprovalRequest;
        const decision = { decision: "approve", actionDigest: request.actionDigest } as const;
        const both = yield* Effect.all(
          [approvals.decide(request.id, decision), approvals.decide(request.id, decision)],
          {
            concurrency: "unbounded",
          },
        );
        yield* settled(thread.id);
        const again = yield* approvals.decide(request.id, decision);
        const events = yield* PubSub.takeAll(subscription);
        return { both, again, events };
      }),
    );

    expect(result.both.map((a) => a.state)).toEqual(["approved", "approved"]);
    expect(result.again.revision).toBe(result.both[0].revision);
    const resolved = result.events.filter((e) => e._tag === "Journaled" && e.entry.type === "ApprovalResolved");
    expect(resolved).toHaveLength(1);
    const states = toolSteps(result.events).map((step) => step.state);
    expect(states.at(-1)).toBe("done");
    expect(states.filter((state) => state === "running").length).toBeLessThanOrEqual(1);
  });

  // covers PE-003
  it("[TC-PE-062] denies with the user's reason, which goes back to the hob, and refuses a later approval", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const bus = yield* EventBus;
        const subscription = yield* bus.subscribe;
        const { thread, pending } = yield* askInNewThread();
        const request = pending[0] as ApprovalRequest;
        const denied = yield* approvals.decide(request.id, {
          decision: "deny",
          actionDigest: request.actionDigest,
          reason: "  Not on Fridays  ",
        });
        const done = yield* settled(thread.id);
        const late = yield* Effect.exit(
          approvals.decide(request.id, { decision: "approve", actionDigest: request.actionDigest }),
        );
        const events = yield* PubSub.takeAll(subscription);
        return { denied, done, late, events };
      }),
    );

    expect(result.denied).toMatchObject({ state: "denied", denyReason: "Not on Fridays" });
    expect(result.done.status).toBe("complete");
    expect(toolSteps(result.events).at(-1)).toMatchObject({
      state: "denied",
      decidedBy: "user",
      reason: expect.stringContaining("Not on Fridays"),
    });
    expect(Exit.isFailure(result.late) && JSON.stringify(result.late.cause)).toContain("ApprovalClosed");
  });

  // covers PE-007
  it("[TC-PE-063] expires the request when the reply is stopped, so it cannot be approved late", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const approvals = yield* ApprovalService;
        const { thread, pending } = yield* askInNewThread();
        const request = pending[0] as ApprovalRequest;
        yield* chat.stop(thread.id);
        const done = yield* settled(thread.id);
        const stored = (yield* approvals.listForThread(thread.id))[0];
        const late = yield* Effect.exit(
          approvals.decide(request.id, { decision: "approve", actionDigest: request.actionDigest }),
        );
        return { done, stored, late };
      }),
    );

    expect(result.done.status).toBe("stopped");
    expect(result.stored?.state).toBe("expired");
    expect(Exit.isFailure(result.late) && JSON.stringify(result.late.cause)).toContain("expired");
  });

  // covers PE-007, AG-006
  it("[TC-PE-072] expires the request when its hob retires, even with its reply left to finish", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const lifecycle = yield* HobLifecycle;
        const { thread, pending } = yield* askInNewThread();
        const request = pending[0] as ApprovalRequest;
        yield* lifecycle.retire(HOB_ID, "finish");
        const done = yield* settled(thread.id);
        const stored = (yield* approvals.listForThread(thread.id))[0];
        const late = yield* Effect.exit(
          approvals.decide(request.id, { decision: "approve", actionDigest: request.actionDigest }),
        );
        return { done, stored, late };
      }),
    );

    expect(result.done.status).toBe("complete");
    expect(result.stored?.state).toBe("expired");
    expect(Exit.isFailure(result.late) && JSON.stringify(result.late.cause)).toContain("ApprovalClosed");
  });

  // covers PE-003
  it("[TC-PE-064] refuses a decision for another action than the one shown", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const approvals = yield* ApprovalService;
        const { thread, pending } = yield* askInNewThread();
        const request = pending[0] as ApprovalRequest;
        const exit = yield* Effect.exit(approvals.decide(request.id, { decision: "approve", actionDigest: "other" }));
        const still = (yield* approvals.listForThread(thread.id))[0];
        yield* chat.stop(thread.id);
        yield* settled(thread.id);
        return { exit, still };
      }),
    );

    expect(Exit.isFailure(result.exit) && JSON.stringify(result.exit.cause)).toContain("ApprovalActionChanged");
    expect(result.still?.state).toBe("pending");
  });

  // covers PE-008
  it("[TC-PE-065] asks again when the policy changes before an approved action runs", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const { thread, pending } = yield* askInNewThread();
        const first = pending[0] as ApprovalRequest;
        // Another rule changes, so the policy the approval was given under is not the one now.
        restrictions = [{ "delete-files": "deny" }];
        yield* approvals.decide(first.id, { decision: "approve", actionDigest: first.actionDigest });
        const second = (yield* pendingIn(thread.id))[0] as ApprovalRequest;
        yield* approvals.decide(second.id, { decision: "approve", actionDigest: second.actionDigest });
        const done = yield* settled(thread.id);
        return { first, second, done };
      }),
    );

    expect(result.second.id).not.toBe(result.first.id);
    expect(result.second.policyVersion).not.toBe(result.first.policyVersion);
    expect(result.second.actionDigest).toBe(result.first.actionDigest);
    expect(result.done.status).toBe("complete");
  });

  // covers PE-003
  it("[TC-PE-073] wakes the waiting turn even when the decision's request is cancelled while it is stored", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);
      const sent = yield* chat.sendPrompt(thread.id, "hello");
      yield* settled(thread.id);
      const messageId = (sent.assistantMessage as Message).id;
      // A store whose decision write holds at the commit until the test lets it go.
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const Gated = Layer.effect(
        ApprovalRepository,
        Effect.map(ApprovalRepository, (live) =>
          ApprovalRepository.of({
            ...live,
            resolve: (next, from) =>
              live
                .resolve(next, from)
                .pipe(
                  Effect.tap(() => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))),
                ),
          }),
        ),
      ).pipe(Layer.provide(ApprovalRepositoryLive));
      return yield* Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const turn = yield* approvals.forTurn(
          { agentId: HOB_ID, threadId: thread.id, messageId },
          Effect.succeed(null),
        );
        const pending = yield* turn.approvals.request({
          stepId: "s1",
          tool: "Bash",
          operation: "push",
          targets: ["origin main"],
          arguments: { command: "git push origin main" },
          label: "Running git push origin main",
          reason: "Pushing asks first.",
          policyVersion: "r1-test",
          onceOnly: false,
          grantable: false,
          rules: [],
        });
        const [request] = yield* approvals.listForThread(thread.id);
        const decision = { decision: "approve", actionDigest: (request as ApprovalRequest).actionDigest } as const;
        const deciding = yield* Effect.forkChild(approvals.decide(pending.approvalId, decision));
        yield* Deferred.await(reached);
        // The client gives up on its request while the decision is being stored.
        const cancelling = yield* Effect.forkChild(Fiber.interrupt(deciding));
        // Lets the interruption reach the decision before its write is let go.
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(cancelling);
        const outcome = yield* pending.decision.pipe(Effect.timeout("2 seconds"));
        const retried = yield* approvals.decide(pending.approvalId, decision);
        return { outcome, retried };
      }).pipe(Effect.provide(Layer.fresh(ApprovalService.layer).pipe(Layer.provide(Gated))));
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.outcome._tag).toBe("Approved");
    expect(result.retried.state).toBe("approved");
  });

  // covers PE-007
  it("[TC-PE-066] expires requests left pending when the server restarts", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);
      const sent = yield* chat.sendPrompt(thread.id, "hello");
      yield* settled(thread.id);
      const messageId = (sent.assistantMessage as Message).id;
      // A turn asks, and the process dies before anyone decides.
      const before = yield* Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const turn = yield* approvals.forTurn(
          { agentId: HOB_ID, threadId: thread.id, messageId },
          Effect.succeed(null),
        );
        yield* turn.approvals.request({
          stepId: "s1",
          tool: "Bash",
          operation: "push",
          targets: ["origin main"],
          arguments: { command: "git push origin main" },
          label: "Running git push origin main",
          reason: "Pushing asks first.",
          policyVersion: "r1-test",
          onceOnly: false,
          grantable: false,
          rules: [],
        });
        return yield* approvals.listForThread(thread.id);
      }).pipe(Effect.provide(Layer.fresh(ApprovalService.layer)));
      // The next process starts.
      const after = yield* Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        return yield* approvals.listForThread(thread.id);
      }).pipe(Effect.provide(Layer.fresh(ApprovalService.layer)));
      return { before, after };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.before.map((a) => a.state)).toEqual(["pending"]);
    expect(result.after.map((a) => a.state)).toEqual(["expired"]);
    expect(result.after[0]?.decidedAt).not.toBeNull();
  });
});

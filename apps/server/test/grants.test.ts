import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  policyLoss,
  type ToolAccess,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type ApprovalRequest,
  EMPTY_HOB_POLICY,
  isInProgress,
  type Message,
  type ThreadId,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { ApprovalRepositoryLive, GrantRepositoryLive, HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Exit, Layer, PubSub, Schedule, type Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

const SCOUT = AgentId.make("scout");
const BRAM = AgentId.make("bram");
const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-grants-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const folder = join(root, "work");
mkdirSync(folder);

const summonHobs = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [SCOUT, "Scout"],
    [BRAM, "Bram"],
  ] as const) {
    yield* repo.insertAgent(
      new Agent({
        id,
        name,
        roleTitle: "Guide",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 7,
        lookColor: "violet",
        configVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  }
});

// Balanced: commands run, while deleting files and pushing ask. Careful offers no commands at all.
let restrictions: ToolAccess["policy"]["restrictions"] = [];
const tools = Layer.succeed(
  HobTools,
  HobTools.of({
    access: (agent) =>
      Effect.sync(() => ({
        policy: {
          preset: "balanced",
          sharedFolders: [folder],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(root, "data"),
          restrictions,
        },
        folders: [folder],
        runtimeFolder: join(root, "runtimes", agent.id),
      })),
  }),
);

const Persistence = Layer.mergeAll(HobbotsRepositoryLive, ApprovalRepositoryLive, GrantRepositoryLive).pipe(
  Layer.provideMerge(TestDatabase),
);
const TestLayer = HobLifecycle.layer.pipe(
  Layer.provideMerge(ChatService.layer.pipe(Layer.provide(tools))),
  Layer.provideMerge(ApprovalService.layer),
  Layer.provideMerge(GrantService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effectDiscard(summonHobs).pipe(Layer.provideMerge(Persistence)),
      EventBus.layer,
      HobAdmission.layer,
      FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
    ),
  ),
);

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ApprovalService | GrantService | ChatService | HobLifecycle | HobbotsRepository | EventBus | Scope.Scope
  >,
) => effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

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

/** Runs the command in a new thread of the hob, and returns the request it waits on, or the finished reply. */
const runCommand = (line: string, agentId: AgentId = SCOUT) =>
  Effect.gen(function* () {
    const chat = yield* ChatService;
    const approvals = yield* ApprovalService;
    const thread = yield* chat.createThread(agentId);
    yield* chat.sendPrompt(thread.id, `Go\nfake:tool Bash ${line}`);
    return yield* Effect.gen(function* () {
      const pending = (yield* approvals.listForThread(thread.id)).find((a) => a.state === "pending");
      if (pending) return { thread, pending, done: undefined };
      const message = yield* reply(thread.id);
      if (message.role === "assistant" && !isInProgress(message.status))
        return { thread, pending: undefined, done: message };
      return yield* Effect.fail("busy" as const);
    }).pipe(Effect.retry(Schedule.spaced("5 millis")));
  });

/** Denies a request so its turn ends. */
const dismiss = (request: ApprovalRequest, threadId: ThreadId) =>
  Effect.gen(function* () {
    const approvals = yield* ApprovalService;
    yield* approvals.decide(request.id, { decision: "deny", actionDigest: request.actionDigest });
    yield* settled(threadId);
  });

describe("Standing grants", () => {
  // covers PE-007, PE-008
  it("[TC-PE-092] approving Always runs the next matching action without asking, until the rule is removed", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const grants = yield* GrantService;
        const bus = yield* EventBus;
        const subscription = yield* bus.subscribe;

        const first = yield* runCommand("rm build");
        const asked = first.pending as ApprovalRequest;
        const approved = yield* approvals.decide(asked.id, {
          decision: "approve",
          actionDigest: asked.actionDigest,
          lifetime: "always",
        });
        const firstDone = yield* settled(first.thread.id);
        const saved = yield* grants.live(SCOUT);

        const again = yield* runCommand("rm build");
        const watch = yield* runCommand("rm build dist");
        if (watch.pending) yield* dismiss(watch.pending, watch.thread.id);
        const install = yield* runCommand("rm dist");
        if (install.pending) yield* dismiss(install.pending, install.thread.id);
        const otherHob = yield* runCommand("rm build", BRAM);
        if (otherHob.pending) yield* dismiss(otherHob.pending, otherHob.thread.id);

        const removed = yield* grants.revoke(saved[0]?.id as never);
        const removedAgain = yield* grants.revoke(saved[0]?.id as never);
        const afterRemoval = yield* runCommand("rm build");
        if (afterRemoval.pending) yield* dismiss(afterRemoval.pending, afterRemoval.thread.id);
        const all = yield* grants.list({ agentId: SCOUT, all: true });
        const events = yield* PubSub.takeAll(subscription);
        return {
          asked,
          approved,
          firstDone,
          saved,
          again,
          watch,
          install,
          otherHob,
          removed,
          removedAgain,
          afterRemoval,
          all,
          events,
        };
      }),
    );

    expect(result.asked).toMatchObject({
      operation: "delete-files",
      grantable: true,
      rules: [{ _tag: "Paths", operation: "delete-files", paths: [join(folder, "build")] }],
    });
    expect(result.asked.expiresAt).not.toBeNull();
    expect(result.approved).toMatchObject({ state: "approved", lifetime: "always" });
    expect(result.firstDone.steps.at(-1)).toMatchObject({ state: "done" });
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]).toMatchObject({
      agentId: SCOUT,
      approvalId: result.asked.id,
      lifetime: "always",
      grantedBy: "user",
    });
    // The next `rm build` runs without a request; deleting anything else, or another hob, still asks.
    expect(result.again.pending).toBeUndefined();
    expect(result.again.done?.steps.at(-1)).toMatchObject({ state: "done" });
    expect(result.watch.pending).toBeDefined();
    expect(result.install.pending).toBeDefined();
    expect(result.otherHob.pending).toBeDefined();
    // Removing it is kept in History, and the next `rm build` asks again.
    expect(result.removed).toMatchObject({ revokedBy: "user", revokeReason: "removed" });
    expect(result.removedAgain.revision).toBe(result.removed.revision);
    expect(result.afterRemoval.pending).toBeDefined();
    expect(result.all).toHaveLength(1);
    expect(result.all[0]?.lastUsedAt).not.toBeNull();
    const journaled = result.events.flatMap((e) => (e._tag === "Journaled" ? [e.entry.type] : []));
    expect(journaled.filter((type) => type.startsWith("Grant"))).toEqual(["GrantCreated", "GrantRevoked"]);
  });

  // covers PE-007
  it("[TC-PE-093] saves one grant for a doubled Always, and refuses lifetimes and rules the request does not offer", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const grants = yield* GrantService;
        const unreadable = yield* runCommand("rm *.tmp");
        const glob = unreadable.pending as ApprovalRequest;
        const globAlways = yield* Effect.exit(
          approvals.decide(glob.id, { decision: "approve", actionDigest: glob.actionDigest, lifetime: "always" }),
        );
        yield* dismiss(glob, unreadable.thread.id);

        const push = yield* runCommand("git push origin main");
        const risky = push.pending as ApprovalRequest;
        const pushAlways = yield* Effect.exit(
          approvals.decide(risky.id, {
            decision: "approve",
            actionDigest: risky.actionDigest,
            confirmed: true,
            lifetime: "always",
          }),
        );
        yield* dismiss(risky, push.thread.id);

        const asked = yield* runCommand("git push origin feature");
        const request = asked.pending as ApprovalRequest;
        const quest = yield* Effect.exit(
          approvals.decide(request.id, { decision: "approve", actionDigest: request.actionDigest, lifetime: "quest" }),
        );
        const broader = yield* Effect.exit(
          approvals.decide(request.id, {
            decision: "approve",
            actionDigest: request.actionDigest,
            lifetime: "always",
            rules: [{ _tag: "Push", cwd: folder, remote: "origin", branch: "other" }],
          }),
        );
        const decision = { decision: "approve", actionDigest: request.actionDigest, lifetime: "always" } as const;
        const both = yield* Effect.all(
          [approvals.decide(request.id, decision), approvals.decide(request.id, decision)],
          {
            concurrency: "unbounded",
          },
        );
        yield* settled(asked.thread.id);
        const once = yield* Effect.exit(
          approvals.decide(request.id, { decision: "approve", actionDigest: request.actionDigest }),
        );
        return { glob, globAlways, risky, pushAlways, quest, broader, both, once, saved: yield* grants.live(SCOUT) };
      }),
    );

    expect(result.glob).toMatchObject({ grantable: false, rules: [] });
    expect(Exit.isFailure(result.globAlways) && JSON.stringify(result.globAlways.cause)).toContain(
      "ApprovalNotGrantable",
    );
    expect(result.risky).toMatchObject({ onceOnly: true, grantable: false });
    expect(Exit.isFailure(result.pushAlways) && JSON.stringify(result.pushAlways.cause)).toContain(
      "ApprovalNotGrantable",
    );
    expect(Exit.isFailure(result.quest) && JSON.stringify(result.quest.cause)).toContain("ApprovalNotGrantable");
    expect(Exit.isFailure(result.broader) && JSON.stringify(result.broader.cause)).toContain("GrantRuleRefused");
    expect(result.both.map((a) => a.revision)).toEqual([result.both[0].revision, result.both[0].revision]);
    // Deciding it again with another lifetime does not change it.
    expect(Exit.isFailure(result.once) && JSON.stringify(result.once.cause)).toContain("ApprovalClosed");
    expect(result.saved).toHaveLength(1);
  });

  // covers PE-007, PE-008
  it("[TC-PE-094] revokes the grants whose authority is taken away, and never brings them back", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const grants = yield* GrantService;
        const lifecycle = yield* HobLifecycle;
        const approveAlways = (line: string, agentId: AgentId) =>
          Effect.gen(function* () {
            const asked = yield* runCommand(line, agentId);
            const request = asked.pending as ApprovalRequest;
            yield* approvals.decide(request.id, {
              decision: "approve",
              actionDigest: request.actionDigest,
              lifetime: "always",
            });
            yield* settled(asked.thread.id);
          });
        yield* approveAlways("rm build", SCOUT);
        yield* approveAlways("rm dist", BRAM);

        // Narrowing an unrelated operation keeps the grant; narrowing Delete files to Never revokes it.
        yield* grants.revokeLost(
          SCOUT,
          policyLoss(EMPTY_HOB_POLICY, { ...EMPTY_HOB_POLICY, overrides: { push: "ask" } }),
        );
        const kept = yield* grants.live(SCOUT);
        yield* grants.revokeLost(
          SCOUT,
          policyLoss(EMPTY_HOB_POLICY, { ...EMPTY_HOB_POLICY, overrides: { "delete-files": "deny" } }),
        );
        const narrowed = yield* grants.list({ agentId: SCOUT, all: true });
        // Removing the shared folder in setup revokes the rules in it, for every hob.
        yield* grants.revokeLost(null, { folders: [folder], operations: [] });
        const bram = yield* grants.list({ agentId: BRAM, all: true });
        yield* lifecycle.retire(BRAM, "finish");
        return { kept, narrowed, bram, live: yield* grants.list({}) };
      }),
    );

    expect(result.kept).toHaveLength(1);
    expect(result.narrowed[0]).toMatchObject({ revokedBy: "hub", revokeReason: "narrowed" });
    expect(result.bram[0]).toMatchObject({ revokedBy: "hub", revokeReason: "folder-removed" });
    expect(result.live).toEqual([]);
  });

  // covers PE-007
  it("[TC-PE-095] revokes every grant of a hob that retires", async () => {
    restrictions = [];
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const grants = yield* GrantService;
        const lifecycle = yield* HobLifecycle;
        const asked = yield* runCommand("git push origin feature");
        const request = asked.pending as ApprovalRequest;
        yield* approvals.decide(request.id, {
          decision: "approve",
          actionDigest: request.actionDigest,
          lifetime: "always",
        });
        yield* settled(asked.thread.id);
        const before = yield* grants.live(SCOUT);
        yield* lifecycle.retire(SCOUT, "finish");
        return { before, after: yield* grants.list({ agentId: SCOUT, all: true }) };
      }),
    );

    expect(result.before).toHaveLength(1);
    expect(result.after[0]).toMatchObject({ revokedBy: "hub", revokeReason: "retired" });
  });
});

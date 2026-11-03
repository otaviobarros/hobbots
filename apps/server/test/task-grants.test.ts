import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalRepository,
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  QuestionService,
  RuntimeAdapter,
  TaskControls,
  TaskRepository,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type ApprovalLifetime,
  type ApprovalRequest,
  EMPTY_HOB_POLICY,
  type Message,
  type PolicyOverrides,
  type TaskTree,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Layer, ManagedRuntime, Option, Schedule, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #352: an approval granted for This Task (ADR 018). The grant is bound to the top Task of
// the request's tree and to the hob that asked: it covers every step, still applies once a party
// joins and the Task becomes a Quest, is never used by another hob, and ends with the top Task. The
// fake runtime scripts every hob's calls; Balanced lets edits run and asks before a push.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-task-grants-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
mkdirSync(project, { recursive: true });

const now = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const threadId = ThreadId.make("launch");
/** A prompt with this line of its own waits, before it does anything, until the test lets it go on. */
const HOLD = "fake:hold";
const PUSH = "git push origin feature";
const push = `fake:tool Bash ${PUSH}`;

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Marketing",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** Each hob's own overrides, which a case may change between turns. */
const overrides = new Map<AgentId, PolicyOverrides>();

const ProjectTools = Layer.succeed(
  HobTools,
  HobTools.of({
    access: (agent) =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [project],
          hob: { ...EMPTY_HOB_POLICY, overrides: overrides.get(agent.id) ?? {} },
          dataFolder: join(temp, "data"),
          restrictions: [],
        },
        folders: [project],
        runtimeFolder: join(temp, "runtime", agent.id),
      }),
  }),
);

/** The fake runtime, with every session whose prompt holds `HOLD` waiting for the gate. */
const held = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          requests.push(request);
          const stream = fake.sendPrompt(request);
          return request.prompt.split("\n").includes(HOLD)
            ? Stream.unwrap(Effect.as(Deferred.await(gate), stream))
            : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

const Party = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const each of [hob(ALDRIC, "Aldric"), hob(QUILL, "Quill")]) yield* repo.insertAgent(each);
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: ALDRIC, title: "Launch", createdAt: now, updatedAt: now }),
    );
  }),
);

const makeApp = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer, TaskControls.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(ContinuationsLive),
    Layer.provideMerge(
      StepRunnerLive().pipe(
        Layer.provideMerge(MemberContinuationsLive),
        Layer.provideMerge(TaskTools.layer("/")),
        Layer.provideMerge(TaskSignal.layer),
      ),
    ),
    Layer.provideMerge(Dispatcher.layer().pipe(Layer.provideMerge(DispatcherHostLive))),
    Layer.provideMerge(Layer.mergeAll(ApprovalService.layer, QuestionService.layer)),
    Layer.provideMerge(GrantService.layer),
    Layer.provideMerge(Party),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        ApprovalRepositoryLive,
        GrantRepositoryLive,
        BackpackLive,
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        ProjectTools,
        HobAdmission.layer,
        held(gate, requests),
        Layer.succeed(UserSession, {
          deviceId: WINDOW_DEVICE_ID,
          name: "This computer's Hobbots window",
          kind: "window",
          whileApproved: (write) => write,
        }),
      ),
    ),
    Layer.provideMerge(TestDatabase),
  );

type App = ReturnType<typeof makeApp>;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<App>, Layer.Error<App>> | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  overrides.clear();
});

const setUp = () => {
  const requests: Array<PromptRequest> = [];
  const gate = Deferred.makeUnsafe<void>();
  const app = ManagedRuntime.make(makeApp(gate, requests));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  return { run, requests, release: () => run(Deferred.succeed(gate, undefined)) };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 800 }));

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** Sends a message in the thread and waits until every reply in it has ended. */
const say = (prompt: string) =>
  Effect.gen(function* () {
    const before = (yield* HobbotsRepository.use((repo) => repo.listMessages(threadId))).length;
    yield* ChatService.use((chat) => chat.sendPrompt(threadId, prompt));
    return yield* messagesWhen((all) => all.length >= before + 2);
  });

/** The thread's messages once `ready` holds for them, every reply ended. */
const messagesWhen = (ready: (all: ReadonlyArray<Message>) => boolean) =>
  retry(
    Effect.gen(function* () {
      const all = yield* HobbotsRepository.use((repo) => repo.listMessages(threadId));
      const ended = all.every((m) => m.status !== "streaming" && m.status !== "stopping");
      return ended && ready(all) ? all : yield* Effect.fail("not yet" as const);
    }),
  );

/** The request's whole tree once `ready` holds for it. */
const treeWhen = (ready: (tree: TaskTree) => boolean) =>
  retry(
    Effect.gen(function* () {
      const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
      return tree !== undefined && ready(tree) ? tree : yield* Effect.fail("not yet" as const);
    }),
  );

/** The hob's pending request, once it asks. */
const pendingFrom = (agentId: AgentId) =>
  retry(
    Effect.flatMap(
      ApprovalRepository.use((approvals) => approvals.listPending),
      (all): Effect.Effect<ApprovalRequest, "not yet"> => {
        const found = all.find((each) => each.agentId === agentId);
        return found === undefined ? Effect.fail("not yet") : Effect.succeed(found);
      },
    ),
  );

const approve = (request: ApprovalRequest, lifetime: ApprovalLifetime) =>
  ApprovalService.use((approvals) =>
    approvals.decide(request.id, { decision: "approve", actionDigest: request.actionDigest, lifetime }),
  );

/** Every request the thread's hobs made, oldest first. */
const asked = () => ApprovalService.use((approvals) => approvals.listForThread(threadId));

/** The steps under the Task you asked for that ran a push, by their checkpoints (EX-004). */
const pushedIn = (tree: TaskTree) =>
  tree.tasks.filter(
    (task) =>
      task.parentId !== null &&
      tree.checkpoints.some((each) => each.taskId === task.id && each.summary.includes("git push")),
  );

/** Aldric starts a Task with a step that waits for the gate, so the Task stays open, then pushes in his chat. */
const taskWithPush = (steps: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* say(
      [
        "Plan the launch",
        hub("plan_steps", { key: "plan", steps: steps.map((brief) => ({ brief: [brief, HOLD].join("\n") })) }),
      ].join("\n"),
    );
    yield* ChatService.use((chat) => chat.sendPrompt(threadId, ["Push the branch", push].join("\n")));
    const request = yield* pendingFrom(ALDRIC);
    const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
    return { request, top: tree?.tasks[0] };
  });

describe("an approval for This Task", () => {
  // covers PE-007, OR-001
  it("[TC-PE-248] binds to the top Task and the hob that asked, and covers every step of the Task without asking", async () => {
    const { run, release } = setUp();
    const { request, top } = await run(taskWithPush([`Push the copy\n${push}`, `Push the images\n${push}`]));

    // The request was made in the Task, which has no party: it offers This Task, bound to that Task.
    expect(top?.parentId).toBeNull();
    expect(request).toMatchObject({ rootTaskId: top?.id, grantable: true, onceOnly: false });
    expect(request.rules).toEqual([{ _tag: "Push", cwd: project, remote: "origin", branch: "feature" }]);
    const decided = await run(approve(request, "task"));
    expect(decided).toMatchObject({ state: "approved", lifetime: "task" });
    const [grant] = await run(GrantService.use((grants) => grants.list({ agentId: ALDRIC })));
    expect(grant).toMatchObject({ agentId: ALDRIC, lifetime: "task", taskId: top?.id, approvalId: request.id });
    expect(grant?.rule).toEqual(request.rules[0]);

    // Each step runs in a fresh session of its own and pushes without asking you again.
    await run(messagesWhen(() => true));
    await release();
    const stepsOf = (tree: TaskTree) => tree.tasks.filter((task) => task.parentId !== null);
    const done = await run(
      treeWhen((tree) => pushedIn(tree).length === 2 && stepsOf(tree).every((step) => step.state === "completed")),
    );
    expect(stepsOf(done)).toHaveLength(2);
    expect((await run(asked())).map((each) => each.id)).toEqual([request.id]);
    const [used] = await run(GrantService.use((grants) => grants.list({ agentId: ALDRIC })));
    expect(used?.lastUsedAt).not.toBeNull();
  }, 30_000);

  // covers PE-007, OR-001
  it("[TC-OR-484] asked from the chat turn on the Task, names that Task, and the Task's ledger still holds it open", async () => {
    const { run } = setUp();
    const { request, top } = await run(taskWithPush(["Wait for the go-ahead"]));
    if (top === undefined) throw new Error("no Task");

    // Issue #670: a chat turn's request had only the top Task, while a member's named its own.
    expect(request).toMatchObject({ taskId: top.id, rootTaskId: top.id });
    expect(request.messageId).not.toBeNull();
    const ledger = await run(TaskRepository.use((tasks) => tasks.readLedger(top.id)));
    expect(ledger.pipe(Option.map((each) => each.open.filter((entry) => entry._tag === "Approval").length))).toEqual(
      Option.some(1),
    );
  }, 30_000);

  // covers PE-004, PE-007, OR-002
  it("[TC-PE-249] still applies once a party joins and the Task becomes a Quest, and Quill never uses Aldric's grant", async () => {
    const { run } = setUp();
    const { request, top } = await run(taskWithPush(["Wait for the go-ahead"]));
    await run(approve(request, "task"));
    await run(messagesWhen((all) => all.at(-1)?.status === "complete"));

    // Aldric brings in Quill: the Task keeps its id and gains its Quest.
    await run(
      say(
        [
          "Get help with the copy",
          hub("delegate_task", { key: "copy", hob: "Quill", brief: ["Push the copy", push].join("\n") }),
        ].join("\n"),
      ),
    );
    const quest = await run(treeWhen((tree) => tree.quests.length === 1));
    expect(quest.tasks[0]?.id).toBe(top?.id);
    expect(quest.quests[0]?.taskId).toBe(top?.id);

    // Quill's same push asks you: the grant is Aldric's. His request is bound to the same top Task.
    const quills = await run(pendingFrom(QUILL));
    expect(quills).toMatchObject({ agentId: QUILL, rootTaskId: top?.id, grantable: true });
    expect(quills.taskId).not.toBe(top?.id);
    await run(approve(quills, "task"));

    // Aldric's push in the Quest still runs on his grant: no new request of his.
    await run(say(["Push again", push].join("\n")));
    const requests = await run(asked());
    expect(requests.filter((each) => each.agentId === ALDRIC).map((each) => each.id)).toEqual([request.id]);
    // Each hob holds its own grant for the same top Task, and neither answers the other's calls.
    const grants = await run(GrantService.use((each) => each.list({})));
    expect(grants.map((grant) => [grant.agentId, grant.lifetime, grant.taskId])).toEqual([
      [ALDRIC, "task", top?.id],
      [QUILL, "task", top?.id],
    ]);
  }, 30_000);

  // covers PE-004, PE-007
  it("[TC-PE-260] a member's call the delegation narrows to Ask offers no This Task or Always", async () => {
    const { run } = setUp();
    const file = join(project, "copy.md");
    await run(
      say(
        [
          "Plan the copy",
          hub("delegate_task", {
            key: "copy",
            hob: "Quill",
            brief: ["Write the copy", `fake:tool Write ${file}`].join("\n"),
            authority: { decisions: { "edit-files": "ask" } },
          }),
        ].join("\n"),
      ),
    );
    // Balanced lets Quill edit; Aldric narrowed it to Ask, so it asks you and no rule can answer it.
    const narrowed = await run(pendingFrom(QUILL));
    expect(narrowed).toMatchObject({ operation: "edit-files", grantable: false, rules: [] });
    expect(narrowed.rootTaskId).not.toBeNull();
    const refused = await run(Effect.flip(approve(narrowed, "task")));
    expect(refused._tag).toBe("ApprovalNotGrantable");
  }, 30_000);

  // covers PE-004, PE-007
  it("[TC-PE-261] an Ask the lead set on purpose stays one no grant answers, even where the member's preset asks too", async () => {
    const { run } = setUp();
    const delegatePush = (key: string) =>
      say(
        ["Get help", hub("delegate_task", { key, hob: "Quill", brief: ["Push the copy", push].join("\n") })].join("\n"),
      );

    // With no override of Aldric's, Quill's push asks only because of the preset: you allow it Always.
    await run(delegatePush("first"));
    const first = await run(pendingFrom(QUILL));
    expect(first).toMatchObject({ grantable: true, onceOnly: false });
    await run(approve(first, "always"));
    await run(treeWhen((tree) => tree.tasks.some((task) => task.parentId !== null && task.state === "completed")));

    // Aldric's own override now asks before every push, the same answer as Balanced. Quill's grant
    // must not answer it: the push asks you again, once only.
    overrides.set(ALDRIC, { push: "ask" });
    await run(delegatePush("second"));
    const second = await run(
      retry(
        Effect.flatMap(asked(), (all) => {
          const found = all.find((each) => each.agentId === QUILL && each.id !== first.id);
          return found === undefined ? Effect.fail("not yet" as const) : Effect.succeed(found);
        }),
      ),
    );
    expect(second).toMatchObject({ operation: "push", state: "pending", grantable: false, rules: [] });
    const [tree] = await run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)));
    // Only the answers given on purpose are passed on: none at first, then Aldric's push Ask.
    expect(tree?.delegations.map((each) => each.authority.overrides)).toEqual([{}, { push: "ask" }]);
  }, 30_000);

  // covers PE-007, PE-008
  it("[TC-PE-259] ends with the top Task: its grants are revoked as it ends, and the next request asks again", async () => {
    const { run } = setUp();
    const { request, top } = await run(taskWithPush(["Wait for the go-ahead"]));
    await run(approve(request, "task"));
    await run(messagesWhen((all) => all.at(-1)?.status === "complete"));
    if (top === undefined) throw new Error("no Task");

    const before = await run(EventJournal.use((journal) => journal.head));
    await run(TaskControls.use((controls) => controls.cancel(top.id)));
    await run(treeWhen((tree) => tree.tasks[0]?.state === "cancelled"));
    const [ended] = await run(GrantService.use((grants) => grants.list({ agentId: ALDRIC, all: true })));
    expect(ended).toMatchObject({ taskId: top.id, revokedBy: "hub", revokeReason: "task-ended" });
    expect(await run(GrantService.use((grants) => grants.live(ALDRIC)))).toEqual([]);
    // The revocation is journaled, so open screens update live.
    const entries = await run(EventJournal.use((journal) => journal.readAfter(before.sequence)));
    expect(entries.some((each) => each.type === "GrantRevoked")).toBe(true);

    // With the Task gone, the same push asks again, and a request outside any Task offers no This Task.
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, ["Push once more", push].join("\n"))));
    const again = await run(
      retry(
        Effect.flatMap(asked(), (all) =>
          all.length === 2 && all[1]?.state === "pending" ? Effect.succeed(all[1]) : Effect.fail("not yet" as const),
        ),
      ),
    );
    expect(again.rootTaskId).toBeNull();
    const refused = await run(Effect.flip(approve(again, "task")));
    expect(refused._tag).toBe("ApprovalNotGrantable");
  }, 30_000);
});

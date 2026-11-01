import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HobbotsRepository, HobTools, RuntimeAdapter, type RuntimeEvent, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  EMPTY_HOB_POLICY,
  type EventEnvelope,
  type TaskId,
  TaskId as TaskIdSchema,
  type TaskToolDone,
  TaskToolRefused,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { TaskTools } from "@hobbots/orchestration";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option, PubSub, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// The hob tools of ADR 018 against a real database: who may call each one, depth, cycles,
// open-Task limits, authority that only narrows, and keys that make a retry return the first result.

const now = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const ROOK = AgentId.make("rook");
const PIP = AgentId.make("pip");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const threadId = ThreadId.make("t1");
const TOP = TaskIdSchema.make("top");

let work: string;

/** Every hob works in `work` under the Balanced preset: deleting files and pushing ask, the rest is allowed. */
const TestHobTools = Layer.sync(HobTools, () =>
  HobTools.of({
    access: (agent) =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [],
          hob: agent.policy,
          dataFolder: join(work, "data"),
          restrictions: [],
        },
        folders: [work],
        runtimeFolder: join(work, "runtimes", agent.id),
      }),
  }),
);

const Persistence = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));
const App = TaskTools.layer({ maxDepth: 2, maxOpenTasksPerHob: 4, maxOpenTasksPerTree: 10 }).pipe(
  Layer.provideMerge(Layer.mergeAll(Persistence, EventBus.layer, NodeFolderChecks, TestHobTools, FakeRuntimeLayer())),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-task-tools-")));
  mkdirSync(join(work, "copy"));
  runtime = ManagedRuntime.make(App);
});

afterEach(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof App>>) => runtime.runPromise(effect);

/** Aldric, Rook, Pip, Quill and Ada; you asked Aldric for the campaign, and his Task has started. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [ALDRIC, "Aldric"],
    [ROOK, "Rook"],
    [PIP, "Pip"],
    [QUILL, "Quill"],
    [ADA, "Ada"],
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
        lookSeed: 1,
        lookColor: "moss",
        configVersion: 1,
        createdAt: now,
        // Ada never uses the web, whatever she is given.
        ...(id === ADA ? { policy: { ...EMPTY_HOB_POLICY, overrides: { "use-web": "deny" as const } } } : {}),
      }),
    );
  }
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: ALDRIC, title: "Campaign", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  const created = yield* tasks.createTask({
    task: {
      id: TOP,
      ownerId: ALDRIC,
      parentId: null,
      threadId,
      brief: "Black Friday campaign",
      dependsOn: [],
      createdAt: now,
    },
    delegation: null,
    milestones: [],
  });
  yield* tasks.startAttempt(TOP, created.value.revision, {
    id: AttemptId.make("top-1"),
    runtime: "claude-code",
    sessionId: null,
    configVersion: 1,
    policyVersion: null,
    startedAt: now,
  });
});

const call = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
  Effect.flatMap(Effect.service(TaskTools), (tools) => tools.call({ agentId, taskId }, name, input));

const done = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
  run(call(agentId, taskId, name, input)) as Promise<TaskToolDone>;

const refused = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
  run(Effect.flip(call(agentId, taskId, name, input)));

const tree = () =>
  run(Effect.flatMap(Effect.service(TaskRepository), (tasks) => tasks.readTree(TOP))).then((found) =>
    Option.getOrThrow(found),
  );

const head = () => run(Effect.flatMap(Effect.service(EventJournal), (journal) => journal.head));

/** Delegates a Task under `taskId` and returns the new Task's id. */
const delegate = async (agentId: AgentId, taskId: TaskId, hob: string, key: string, extra: object = {}) =>
  TaskIdSchema.make(
    String(
      (await done(agentId, taskId, "delegate_task", { key, hob, brief: `Work for ${hob}`, ...extra })).details.task_id,
    ),
  );

describe("hob tools for Tasks and Quests", () => {
  // covers OR-001, EX-001
  it("[TC-OR-010] plans steps once per key, however often the call is retried", async () => {
    await run(seed);
    const input = { key: "plan-1", steps: [{ brief: "Research keywords" }, { brief: "Draft copy", after: [1] }] };
    const first = await done(ALDRIC, TOP, "plan_steps", input);
    const before = await head();
    const again = await done(ALDRIC, TOP, "plan_steps", input);
    expect(again).toEqual(first);
    expect(await head()).toEqual(before);
    const { tasks } = await tree();
    expect(tasks.map((task) => task.ownerId)).toEqual([ALDRIC, ALDRIC, ALDRIC]);
    const research = tasks.find((task) => task.brief === "Research keywords");
    const draft = tasks.find((task) => task.brief === "Draft copy");
    expect(draft?.dependsOn).toEqual([research?.id]);

    // The same key and input from another Task's turn is another call, not a retry.
    const [step] = (first.details.steps as Array<{ readonly task_id: string }>).map((each) =>
      TaskIdSchema.make(each.task_id),
    );
    if (step === undefined) throw new Error("expected a step");
    const fromStep = await refused(ALDRIC, step, "plan_steps", input);
    expect(fromStep.reason).toBe("key-reused");

    const reused = await refused(ALDRIC, TOP, "plan_steps", { ...input, steps: [{ brief: "Something else" }] });
    expect(reused).toBeInstanceOf(TaskToolRefused);
    expect(reused.reason).toBe("key-reused");
    expect((await tree()).tasks).toHaveLength(3);
  });

  // covers OR-001, OR-002
  it("[TC-OR-011] a first delegation makes the Task a Quest, and a retry delegates once", async () => {
    await run(seed);
    const input = { key: "copy", hob: "Quill", brief: "Draft the copy", milestones: ["Outline"] };
    const first = await done(ALDRIC, TOP, "delegate_task", input);
    expect(first.details.quest_started).toBe(true);
    expect(await done(ALDRIC, TOP, "delegate_task", input)).toEqual(first);
    const second = await done(ALDRIC, TOP, "delegate_task", { key: "build", hob: "ada", brief: "Build it" });
    expect(second.details.quest_started).toBe(false);
    expect(second.details.quest_id).toBe(first.details.quest_id);
    const { tasks, quests, delegations, milestones } = await tree();
    expect(tasks.map((task) => task.ownerId)).toEqual([ALDRIC, QUILL, ADA]);
    expect(quests).toHaveLength(1);
    expect(quests[0]?.leadId).toBe(ALDRIC);
    expect(delegations.map((each) => each.memberId)).toEqual([QUILL, ADA]);
    expect(milestones.map((each) => each.title)).toEqual(["Outline"]);
  });

  // covers OR-002, PE-004
  it("[TC-OR-012] a member's authority is the lead's narrowed by the brief, never wider", async () => {
    await run(seed);
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy", {
      authority: { decisions: { push: "deny", "run-commands": "ask" }, folders: [join(work, "copy")] },
    });
    const [delegation] = (await tree()).delegations;
    expect(delegation?.childTaskId).toBe(quill);
    expect(delegation?.authority.overrides).toMatchObject({
      push: "deny",
      "run-commands": "ask",
      "delete-files": "ask",
      "edit-files": "allow",
    });
    expect(delegation?.authority.folders).toEqual([join(work, "copy")]);

    const wider = await refused(ALDRIC, TOP, "delegate_task", {
      key: "wide",
      hob: "Ada",
      brief: "Delete the old campaign",
      authority: { decisions: { "delete-files": "allow" } },
    });
    expect(wider.reason).toBe("authority-wider");
    expect(wider.message).toContain("delete-files");

    const elsewhere = await refused(ALDRIC, TOP, "delegate_task", {
      key: "elsewhere",
      hob: "Ada",
      brief: "Work in my home",
      authority: { folders: [tmpdir()] },
    });
    expect(elsewhere.reason).toBe("authority-wider");

    // Quill passes on at most what she was given: no run-commands Allow, no folder beyond hers.
    const pass = await refused(QUILL, quill, "delegate_task", {
      key: "pass",
      hob: "Pip",
      brief: "Run the linter",
      authority: { decisions: { "run-commands": "allow" } },
    });
    expect(pass.reason).toBe("authority-wider");
    const pip = await delegate(QUILL, quill, "Pip", "pip");
    // A member's own policy narrows what it is given: the intersection of the lead's and its own.
    const ada = await delegate(ALDRIC, TOP, "Ada", "ada");
    const adas = (await tree()).delegations.find((each) => each.childTaskId === ada);
    expect(adas?.authority.overrides).toMatchObject({ "use-web": "deny", "edit-files": "allow" });
    const given = (await tree()).delegations.find((each) => each.childTaskId === pip);
    expect(given?.authority.overrides).toMatchObject({ push: "deny", "run-commands": "ask" });
    expect(given?.authority.folders).toEqual([join(work, "copy")]);
  });

  // covers OR-001, OR-004
  it("[TC-OR-013] a hob never acts outside its own subtree", async () => {
    await run(seed);
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy");
    const ada = await delegate(ALDRIC, TOP, "Ada", "build");

    const notOwner = await refused(QUILL, quill, "report_checkpoint", {
      key: "k1",
      task_id: TOP,
      kind: "finding",
      summary: "Aldric's work is mine now",
    });
    expect(notOwner.reason).toBe("outside-subtree");
    const sibling = await refused(QUILL, quill, "cancel_task", { key: "k2", task_id: ada });
    expect(sibling.reason).toBe("outside-subtree");
    const members = await refused(ALDRIC, TOP, "complete_task", { key: "k9", task_id: quill, summary: "Mine" });
    expect(members.reason).toBe("not-owner");
    const turn = await refused(QUILL, TOP, "plan_steps", { key: "k3", steps: [{ brief: "Take over" }] });
    expect(turn.reason).toBe("not-owner");

    // A Task in another tree is out of reach, even for the hob that owns it.
    const tasks = await run(Effect.service(TaskRepository));
    await run(
      tasks.createTask({
        task: {
          id: TaskIdSchema.make("other"),
          ownerId: QUILL,
          parentId: null,
          threadId: null,
          brief: "Quill's own errand",
          dependsOn: [],
          createdAt: now,
        },
        delegation: null,
        milestones: [],
      }),
    );
    const otherTree = await refused(QUILL, quill, "report_checkpoint", {
      key: "k4",
      task_id: "other",
      kind: "progress",
      summary: "Half way",
    });
    expect(otherTree.reason).toBe("outside-subtree");

    // A step's session reaches only its own step, never its sibling or the Task above.
    const planned = await done(ALDRIC, TOP, "plan_steps", { key: "s", steps: [{ brief: "One" }, { brief: "Two" }] });
    const [one, two] = (planned.details.steps as Array<{ readonly task_id: string }>).map((step) =>
      TaskIdSchema.make(step.task_id),
    );
    if (one === undefined || two === undefined) throw new Error("expected two steps");
    expect((await refused(ALDRIC, one, "cancel_task", { key: "k6", task_id: two })).reason).toBe("outside-subtree");
    expect((await refused(ALDRIC, one, "ask", { key: "k7", task_id: TOP, question: "?" })).reason).toBe(
      "outside-subtree",
    );
    expect((await refused(ALDRIC, one, "cancel_task", { key: "k8", task_id: one })).reason).toBe("not-lead");

    const before = await head();
    expect((await refused(ADA, ada, "hand_off", { key: "k5", artifact_id: "nope", to_task_id: quill })).reason).toBe(
      "artifact-missing",
    );
    expect(await head()).toEqual(before);
  });

  // covers OR-004
  it("[TC-OR-014] delegation past the depth limit or in a cycle is refused with a reason", async () => {
    await run(seed);
    const rook = await delegate(ALDRIC, TOP, "Rook", "rook");
    const pip = await delegate(ROOK, rook, "Pip", "pip");
    const quests = (await tree()).quests;
    expect(quests.map((quest) => quest.depth)).toEqual([1, 2]);

    const before = await head();
    const deep = await refused(PIP, pip, "delegate_task", { key: "deep", hob: "Quill", brief: "One more level" });
    expect(deep.reason).toBe("depth-limit");
    // Steps never add depth.
    expect((await done(PIP, pip, "plan_steps", { key: "steps", steps: [{ brief: "Do it myself" }] })).message).toMatch(
      /Planned 1 steps/,
    );

    const back = await refused(ROOK, rook, "delegate_task", { key: "back", hob: "Aldric", brief: "Your turn" });
    expect(back.reason).toBe("cycle");
    const loop = await refused(PIP, pip, "start_quest", { key: "loop", goal: "Bring in more", max_depth: 3 });
    expect(loop.reason).toBe("depth-limit");
    const self = await refused(ROOK, rook, "delegate_task", { key: "self", hob: "rook", brief: "Me again" });
    expect(self.reason).toBe("own-hob");
    expect((await tree()).tasks).toHaveLength(4);
    expect((await head()).sequence).toBeGreaterThan(before.sequence);
  });

  // covers OR-004
  it("[TC-OR-015] open-Task limits hold per hob and per tree", async () => {
    await run(seed);
    for (const key of ["a", "b", "c", "d"]) await delegate(ALDRIC, TOP, "Quill", key);
    const full = await refused(ALDRIC, TOP, "delegate_task", { key: "e", hob: "Quill", brief: "One too many" });
    expect(full.reason).toBe("concurrency-limit");
    const steps = Array.from({ length: 6 }, (_, i) => ({ brief: `Step ${i + 1}` }));
    expect((await refused(ALDRIC, TOP, "plan_steps", { key: "many", steps })).reason).toBe("concurrency-limit");
  });

  // covers OR-001, OR-003, OR-006
  it("[TC-OR-016] questions climb, results hand off, waits record and cancels reach the subtree", async () => {
    await run(seed);
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy");
    const ada = await delegate(ALDRIC, TOP, "Ada", "build", { depends_on: [quill] });

    const asked = await done(ADA, ada, "ask", { key: "q", question: "Which audience?" });
    expect(asked.details.recipient).toBe(ALDRIC);
    const notMine = await refused(QUILL, quill, "answer", {
      key: "a",
      question_id: asked.details.question_id,
      answer: "x",
    });
    expect(notMine.reason).toBe("outside-subtree");
    const up = await done(ALDRIC, TOP, "escalate", { key: "e", question_id: asked.details.question_id });
    expect(up.details.recipient).toBeNull();
    const passedOn = await refused(ALDRIC, TOP, "answer", {
      key: "a2",
      question_id: asked.details.question_id,
      answer: "x",
    });
    expect(passedOn.reason).toBe("not-recipient");

    const waiting = await done(ALDRIC, TOP, "wait_for", { key: "w", tasks: [quill, ada], mode: "all" });
    expect(waiting.details.states).toEqual({ [quill]: "queued", [ada]: "queued" });
    const after = await tree();
    expect(after.tasks[0]?.state).toBe("waiting");
    expect(after.waits).toEqual([expect.objectContaining({ taskId: TOP, on: [quill, ada], mode: "all" })]);
    expect((await refused(ALDRIC, TOP, "wait_for", { key: "w2", tasks: ["other"] })).reason).toBe(
      "wait-outside-subtree",
    );

    // Quill finishes her copy, and Aldric hands it to Ada.
    const tasks = await run(Effect.service(TaskRepository));
    const started = await run(
      tasks.startAttempt(quill, (await tree()).tasks[1]?.revision ?? 0, {
        id: AttemptId.make("quill-1"),
        runtime: "claude-code",
        sessionId: null,
        configVersion: 1,
        policyVersion: null,
        startedAt: now,
      }),
    );
    expect(started.value.task.state).toBe("active");
    const finished = await done(QUILL, quill, "complete_task", {
      key: "c",
      summary: "Copy drafted",
      artifacts: [{ kind: "text", label: "Copy", value: "Shop the deals" }],
    });
    const [artifact] = finished.details.artifacts as Array<string>;
    const handed = await done(ALDRIC, TOP, "hand_off", { key: "h", artifact_id: artifact, to_task_id: ada });
    expect(handed.message).toContain("Copy");
    expect(
      (await refused(QUILL, quill, "hand_off", { key: "h2", artifact_id: artifact, to_task_id: ada })).reason,
    ).toBe("not-lead");
    expect((await tree()).handOffs).toEqual([expect.objectContaining({ artifactId: artifact, toTaskId: ada })]);

    // Cancelling Ada's queued Task confirms it at once; nothing ran there.
    const cancelled = await done(ALDRIC, TOP, "cancel_task", { key: "x", task_id: ada });
    expect(cancelled.details).toEqual({ cancelled: [ada], cancelling: [] });
    expect((await refused(ADA, ada, "ask", { key: "q2", question: "Still there?" })).reason).toBe("task-ended");
  });

  // covers OR-001
  it("[TC-OR-017] a refused or malformed call writes nothing and says why", async () => {
    await run(seed);
    const before = await head();
    expect((await refused(ALDRIC, TOP, "summon_army", { key: "k" })).reason).toBe("unknown-tool");
    expect((await refused(ALDRIC, TOP, "plan_steps", { key: "k", steps: [] })).reason).toBe("invalid-input");
    expect((await refused(ALDRIC, TOP, "plan_steps", { steps: [{ brief: "No key" }] })).reason).toBe("invalid-input");
    const early = await refused(ALDRIC, TOP, "plan_steps", { key: "k", steps: [{ brief: "First", after: [1] }] });
    expect(early.reason).toBe("invalid-input");
    expect((await refused(ALDRIC, TOP, "delegate_task", { key: "k", hob: "Nobody", brief: "x" })).reason).toBe(
      "hob-missing",
    );
    expect(await head()).toEqual(before);
    // A key that only ever led to refusals is still free.
    const planned = await done(ALDRIC, TOP, "plan_steps", { key: "k", steps: [{ brief: "Now it works" }] });
    const [step] = planned.details.steps as Array<{ readonly task_id: string }>;
    // A step that has not started has no result to return.
    const unstarted = await refused(ALDRIC, TOP, "complete_task", {
      key: "c",
      task_id: step?.task_id,
      summary: "Done",
    });
    expect(unstarted.reason).toBe("no-attempt");
  });

  // covers OR-001, EX-001
  it("[TC-OR-018] the fake runtime scripts every tool through the turn's hub tools", async () => {
    await run(seed);
    const prompt = [
      "Plan the campaign",
      'fake:hub plan_steps {"key":"s","steps":[{"brief":"Research"}]}',
      'fake:hub delegate_task {"key":"d","hob":"Quill","brief":"Draft the copy"}',
      'fake:hub delegate_task {"key":"loop","hob":"Aldric","brief":"Back to me"}',
    ].join("\n");
    const turn = Effect.gen(function* () {
      const tools = yield* TaskTools;
      const adapter = yield* RuntimeAdapter;
      const request = {
        prompt,
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
        hubTools: tools.forTurn({ agentId: ALDRIC, taskId: TOP }),
      };
      return yield* Stream.runCollect(adapter.sendPrompt(request));
    });
    const events = (await run(turn)) as ReadonlyArray<RuntimeEvent>;
    expect(events.filter((event) => event._tag === "StepStarted").map((event) => event.label)).toEqual([
      "Thinking",
      "Planning steps",
      "Delegating a Task",
      "Delegating a Task",
    ]);
    const completed = events.find((event) => event._tag === "Completed");
    expect(completed?._tag === "Completed" && completed.text).toMatch(/plan_steps: Planned 1 steps/);
    expect(completed?._tag === "Completed" && completed.text).toMatch(/delegate_task: Delegated Task .* to Quill/);
    expect(completed?._tag === "Completed" && completed.text).toMatch(/delegate_task: Refused \(own-hob\)/);

    // The same turn again, as after a cut-off reply: every call is a retry, and nothing is added.
    const before = await head();
    await run(turn);
    expect((await tree()).tasks).toHaveLength(3);
    expect(await head()).toEqual(before);
  });

  it("announces what a call journaled once it commits", async () => {
    await run(seed);
    const seen: Array<EventEnvelope> = [];
    await run(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const subscription = yield* bus.subscribe;
        yield* call(ALDRIC, TOP, "report_checkpoint", { key: "p", kind: "progress", summary: "Under way" });
        const next = yield* PubSub.take(subscription);
        if (next._tag === "Journaled") seen.push(next.entry);
      }).pipe(Effect.scoped),
    );
    expect(seen.map((entry) => entry.type)).toEqual(["CheckpointRecorded"]);
  });
});

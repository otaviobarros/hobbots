import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { HobbotsRepository, HobTools, RuntimeAdapter, type RuntimeEvent, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  type CarriedItem,
  carriedFrom,
  EMPTY_HOB_POLICY,
  type EventEnvelope,
  type TaskId,
  TaskId as TaskIdSchema,
  type TaskToolDone,
  type TaskToolName,
  TaskToolRefused,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { TaskTools } from "@hobbots/orchestration";
import {
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
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
        commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
      }),
  }),
);

const Persistence = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  BackpackLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));
const App = TaskTools.layer(sep === "\\" ? "\\" : "/", {
  maxDepth: 2,
  maxOpenTasksPerHob: 4,
  maxOpenTasksPerTree: 10,
}).pipe(
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

/**
 * A call from a turn that carries what its Task's ledger holds in its hob's backpack, as a step's
 * brief carries its Task item and a continuation carries what arrived.
 */
const carrying = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const ledger = Option.getOrThrow(yield* (yield* TaskRepository).readLedger(taskId));
    const tools = yield* TaskTools;
    return yield* tools.call({ agentId, taskId, carried: carriedFrom(ledger, () => true) }, name, input);
  });

const tree = () =>
  run(Effect.flatMap(Effect.service(TaskRepository), (tasks) => tasks.readTree(TOP))).then((found) =>
    Option.getOrThrow(found),
  );

const head = () => run(Effect.flatMap(Effect.service(EventJournal), (journal) => journal.head));

/** What was journaled since `before`: only the refusals recorded (#575), so nothing else was written. */
const onlyRefusalsSince = async (before: { readonly sequence: number }) => {
  const entries = await run(
    Effect.flatMap(Effect.service(EventJournal), (journal) => journal.readAfter(before.sequence)),
  );
  expect(entries.filter((entry) => entry.type !== "ToolCallRefused")).toEqual([]);
  return entries;
};

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

    // Another call with the same key on the same Task is refused.
    const reused = await refused(ALDRIC, TOP, "plan_steps", { ...input, steps: [{ brief: "Something else" }] });
    expect(reused).toBeInstanceOf(TaskToolRefused);
    expect(reused.reason).toBe("key-reused");
    expect((await tree()).tasks).toHaveLength(3);

    // The same key from another Task's turn is a call of its own there, never the first one's result (#660).
    const [step] = (first.details.steps as Array<{ readonly task_id: string }>).map((each) =>
      TaskIdSchema.make(each.task_id),
    );
    if (step === undefined) throw new Error("expected a step");
    const fromStep = await done(ALDRIC, step, "report_checkpoint", {
      key: input.key,
      kind: "progress",
      summary: "Keywords listed",
    });
    expect(fromStep).not.toEqual(first);
    expect((await tree()).checkpoints.map((each) => each.summary)).toContain("Keywords listed");
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

  // covers OR-001, OR-002, UX-002
  it("[TC-OR-541] a checkpoint keeps its short summary and its detail apart, and the first delegation in the chat asks for the plan once", async () => {
    await run(seed);
    const first = await done(ALDRIC, TOP, "delegate_task", { key: "copy", hob: "Quill", brief: "Draft the copy" });
    expect(first.message).toContain("tell the user the plan in a line or two");
    const second = await done(ALDRIC, TOP, "delegate_task", { key: "build", hob: "Ada", brief: "Build it" });
    expect(second.message).not.toContain("tell the user the plan");
    const quill = TaskIdSchema.make(String(first.details.task_id));
    await done(QUILL, quill, "report_checkpoint", {
      key: "short",
      kind: "finding",
      summary: "Two headlines too long",
      detail: "Both run past 60 characters, so the landing page wraps them.",
    });
    await done(QUILL, quill, "report_checkpoint", {
      key: "plain",
      kind: "progress",
      summary: "Three headlines drafted",
    });
    const reported = (await tree()).checkpoints.filter((each) => each.taskId === quill && each.source !== "automatic");
    expect(reported.map(({ summary, detail }) => ({ summary, detail }))).toEqual([
      { summary: "Two headlines too long", detail: "Both run past 60 characters, so the landing page wraps them." },
      { summary: "Three headlines drafted", detail: null },
    ]);
    // The lead reads the detail with the summary, so nothing put beyond the beat is lost to it.
    const read = await done(ALDRIC, TOP, "read_tasks", { key: "read" });
    const tasksRead = read.details.tasks as ReadonlyArray<{
      readonly task_id: string;
      readonly recent_checkpoints: ReadonlyArray<{ readonly summary: string; readonly detail?: string }>;
    }>;
    expect(tasksRead.find((each) => each.task_id === quill)?.recent_checkpoints).toEqual([
      expect.objectContaining({ summary: "Three headlines drafted" }),
      expect.objectContaining({
        summary: "Two headlines too long",
        detail: "Both run past 60 characters, so the landing page wraps them.",
      }),
    ]);
    // A member's own Quest has no chat of its own, so its first delegation asks for no plan.
    const nested = await done(QUILL, quill, "delegate_task", { key: "pip", hob: "Pip", brief: "Find keywords" });
    expect(nested.message).not.toContain("tell the user the plan");
  });

  // covers OR-002, PE-004
  it("[TC-OR-012] a member's authority is the lead's narrowed by the brief, never wider", async () => {
    await run(seed);
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy", {
      authority: { decisions: { push: "deny", "run-commands": "ask" }, folders: [join(work, "copy")] },
    });
    const [delegation] = (await tree()).delegations;
    expect(delegation?.childTaskId).toBe(quill);
    // Only the answers given on purpose: the preset's own Asks, such as deleting files, are not copied.
    expect(delegation?.authority.overrides).toEqual({ push: "deny", "run-commands": "ask" });
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
    // Aldric gave Ada nothing on purpose, so her Delegation holds no answer: her own policy, with
    // its web Deny, still narrows her when she runs.
    const ada = await delegate(ALDRIC, TOP, "Ada", "ada");
    const adas = (await tree()).delegations.find((each) => each.childTaskId === ada);
    expect(adas?.authority.overrides).toEqual({});
    // What Quill was given passes on to Pip.
    const given = (await tree()).delegations.find((each) => each.childTaskId === pip);
    expect(given?.authority.overrides).toEqual({ push: "deny", "run-commands": "ask" });
    expect(given?.authority.folders).toEqual([join(work, "copy")]);

    // Only the hub's own separator divides folders: on macOS and Linux this one sits beside Quill's.
    if (sep === "/") {
      mkdirSync(join(work, "copy\\outside"));
      const sibling = await refused(QUILL, quill, "delegate_task", {
        key: "sibling",
        hob: "Rook",
        brief: "Work next door",
        authority: { folders: [join(work, "copy\\outside")] },
      });
      expect(sibling.reason).toBe("authority-wider");
    }
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
    const members = await refused(ALDRIC, TOP, "complete_task", {
      delivered: true,
      key: "k9",
      task_id: quill,
      summary: "Mine",
    });
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
    const noArtifact = await refused(ADA, ada, "hand_off", { key: "k5", artifact_id: "nope", to_task_id: quill });
    expect(noArtifact.reason).toBe("artifact-missing");
    // With no artifact anywhere, it says there is nothing to hand off and what to use instead (#1088).
    expect(noArtifact.message).toContain("No Task under yours has returned an artifact yet");
    expect(noArtifact.message).toContain("message_task");
    await onlyRefusalsSince(before);
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
  it("[TC-OR-024] a Quest started above another one later still limits the work under both", async () => {
    await run(seed);
    const planned = await done(ALDRIC, TOP, "plan_steps", { key: "s", steps: [{ brief: "Research" }] });
    const [step] = (planned.details.steps as Array<{ readonly task_id: string }>).map((each) =>
      TaskIdSchema.make(each.task_id),
    );
    if (step === undefined) throw new Error("expected a step");
    // The step's Quest starts first, with the hub's limits; the top Task's starts after, narrower.
    await done(ALDRIC, TOP, "start_quest", { key: "inner", task_id: step, goal: "Research" });
    await done(ALDRIC, TOP, "start_quest", {
      key: "outer",
      goal: "Campaign",
      max_depth: 1,
      deadline: "2099-01-01T00:00:00.000Z",
    });

    const rook = await delegate(ALDRIC, TOP, "Rook", "rook", { task_id: step });
    const deep = await refused(ROOK, rook, "delegate_task", { key: "deep", hob: "Pip", brief: "One more level" });
    expect(deep.reason).toBe("depth-limit");

    const more = await done(ALDRIC, TOP, "plan_steps", { key: "more", task_id: step, steps: [{ brief: "Sources" }] });
    const sources = String((more.details.steps as Array<{ readonly task_id: string }>)[0]?.task_id);
    const later = await refused(ALDRIC, TOP, "start_quest", {
      key: "later",
      task_id: sources,
      goal: "Sources",
      deadline: "2099-06-01T00:00:00.000Z",
    });
    expect(later.reason).toBe("authority-wider");
    expect(later.message).toContain("2099-01-01T00:00:00.000Z");
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
    // Aldric's turn still runs, so his Task stays active until it ends (#572).
    expect(after.tasks[0]?.state).toBe("active");
    expect(after.waits).toEqual([expect.objectContaining({ taskId: TOP, on: [quill, ada], mode: "all" })]);
    expect((await refused(ALDRIC, TOP, "wait_for", { key: "w2", tasks: ["other"] })).reason).toBe(
      "wait-outside-subtree",
    );
    // Its own Task's id is refused too, with the ids it can wait for (#1088).
    const own = await refused(ALDRIC, TOP, "wait_for", { key: "w3", tasks: [TOP] });
    expect(own.message).toContain(`${TOP} is the Task that waits, your own`);
    expect(own.message).toContain(`The Tasks under it still open: ${quill}, ${ada}.`);

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
    const finished = (await run(
      carrying(QUILL, quill, "complete_task", {
        delivered: true,
        key: "c",
        summary: "Copy drafted",
        artifacts: [{ kind: "text", label: "Copy", value: "Shop the deals" }],
      }),
    )) as TaskToolDone;
    const [artifact] = finished.details.artifacts as Array<string>;
    // A Task's id is not an artifact's: the refusal says so and names the artifacts there are (#1088).
    const byTask = await refused(ALDRIC, TOP, "hand_off", { key: "h0", artifact_id: quill, to_task_id: ada });
    expect(byTask.reason).toBe("artifact-missing");
    expect(byTask.message).toContain(`${quill} is a Task's id`);
    expect(byTask.message).toContain(`Copy (artifact_id ${artifact}, from Task ${quill})`);
    // A member never learns of a sibling's artifacts from the refusal, nor that its id is a Task's.
    const sibling = await refused(ADA, ada, "hand_off", { key: "h1", artifact_id: quill, to_task_id: ada });
    expect(sibling.reason).toBe("artifact-missing");
    expect(sibling.message).not.toContain(artifact);
    expect(sibling.message).not.toContain("Copy");
    expect(sibling.message).not.toContain("is a Task's id");
    expect(sibling.message).toContain("No Task under yours has returned an artifact yet");
    const read = await done(ALDRIC, TOP, "read_tasks", { key: "r-art" });
    expect(
      (read.details.tasks as ReadonlyArray<{ readonly task_id: string; readonly artifacts?: unknown }>).find(
        (each) => each.task_id === quill,
      )?.artifacts,
    ).toEqual([{ artifact_id: artifact, label: "Copy", kind: "text" }]);
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

  // covers IN-006, EX-006
  it("[TC-OR-050] completing a Quest with a member's result still unread is refused and names that result", async () => {
    await run(seed);
    await done(ALDRIC, TOP, "start_quest", { key: "quest", goal: "Launch the campaign" });
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy");
    const tasks = await run(Effect.service(TaskRepository));
    const member = (await tree()).tasks.find((each) => each.id === quill);
    await run(
      tasks.startAttempt(quill, member?.revision ?? 0, {
        id: AttemptId.make("quill-1"),
        runtime: "claude-code",
        sessionId: null,
        configVersion: 1,
        policyVersion: null,
        startedAt: now,
      }),
    );
    // A turn that never took up Quill's Task item cannot finish it either.
    const untaken = await refused(QUILL, quill, "complete_task", {
      delivered: true,
      key: "c0",
      summary: "Copy drafted",
    });
    expect(untaken.reason).toBe("items-open");
    await run(carrying(QUILL, quill, "complete_task", { delivered: true, key: "c", summary: "Copy drafted" }));

    // Quill's result sits in Aldric's backpack, unread: a final sentence alone does not close the Quest.
    const unread = await refused(ALDRIC, TOP, "complete_task", {
      delivered: true,
      key: "done-1",
      summary: "Campaign launched",
    });
    expect(unread.reason).toBe("items-open");
    expect(unread.message).toContain(`the result of Task ${quill} (Work for Quill) is in your backpack, not yet read`);
    const ledger = Option.getOrThrow(await run(tasks.readLedger(TOP)));
    expect(ledger.open).toEqual([
      expect.objectContaining({ _tag: "Item", item: expect.objectContaining({ kind: "result", taskId: quill }) }),
    ]);
    expect((await tree()).quests[0]?.state).toBe("active");

    // The turn that carries the result completes the Quest and consumes the result with it.
    await run(carrying(ALDRIC, TOP, "complete_task", { delivered: true, key: "done-2", summary: "Campaign launched" }));
    const after = await tree();
    expect(after.tasks[0]?.state).toBe("completed");
    expect(after.quests[0]?.state).toBe("completed");
    expect(Option.getOrThrow(await run(tasks.readLedger(TOP))).open).toEqual([]);
  });

  // covers IN-006, OR-001 (#662)
  it("[TC-OR-460] a lead that cancels or reads what ended completes in the same turn, without retrying", async () => {
    await run(seed);
    await done(ALDRIC, TOP, "start_quest", { key: "quest", goal: "Launch the campaign" });
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy");
    const ada = await delegate(ALDRIC, TOP, "Ada", "art");
    // Ada's Task is cancelled from an earlier turn, so its failure waits unread in Aldric's backpack.
    await done(ALDRIC, TOP, "cancel_task", { key: "drop-art", task_id: ada });
    const lone = await refused(ALDRIC, TOP, "complete_task", {
      delivered: true,
      key: "early",
      summary: "Campaign launched",
    });
    expect(lone.message).toContain(`Task ${ada} (Work for Ada) cancelled, and you have not read it yet`);
    expect(lone.message).toContain("Call read_tasks to read what ended");
    expect(lone.message).toContain("or end your turn");

    // One turn: it reads Ada's failure, cancels Quill's Task itself, and completes at the first try.
    const prompt = [
      "Wrap up the campaign",
      'fake:hub read_tasks {"key":"look"}',
      `fake:hub cancel_task {"key":"drop-copy","task_id":"${quill}"}`,
      'fake:hub complete_task {"delivered":true,"key":"wrap","summary":"Campaign launched without copy or art"}',
    ].join("\n");
    const turn = Effect.gen(function* () {
      const tools = yield* TaskTools;
      const adapter = yield* RuntimeAdapter;
      return yield* Stream.runCollect(
        adapter.sendPrompt({
          prompt,
          sessionId: null,
          instructions: "",
          instructionsChanged: false,
          model: null,
          effort: null,
          hubTools: tools.forTurn({ agentId: ALDRIC, taskId: TOP }),
        }),
      );
    });
    const events = (await run(turn)) as ReadonlyArray<RuntimeEvent>;
    const completed = events.find((event) => event._tag === "Completed");
    expect(completed?._tag === "Completed" && completed.text).toMatch(/complete_task: Task top is complete/);
    const after = await tree();
    expect(after.tasks.find((each) => each.id === TOP)?.state).toBe("completed");
    expect(after.quests[0]?.state).toBe("completed");
    const tasks = await run(Effect.service(TaskRepository));
    expect(Option.getOrThrow(await run(tasks.readLedger(TOP))).open).toEqual([]);
  });

  // covers OR-001, OR-002 (#743)
  it("[TC-OR-654] a milestone reached through another hob's work in the same work is recorded with that hob", async () => {
    await run(seed);
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy", { milestones: ["Copy drafted", "Committed"] });
    await delegate(ALDRIC, TOP, "Pip", "email");
    const [drafted, committed] = (await tree()).milestones.filter((each) => each.taskId === quill);
    if (drafted === undefined || committed === undefined) throw new Error("expected two milestones");

    // Naming a hob outside this work, or naming one on anything but a milestone, is refused and writes nothing.
    const before = await head();
    const outsider = await refused(QUILL, quill, "report_checkpoint", {
      key: "outsider",
      kind: "milestone",
      summary: "Committed",
      milestone_id: committed.id,
      reached_by: "Rook",
    });
    expect(outsider.reason).toBe("hob-missing");
    const progress = await refused(QUILL, quill, "report_checkpoint", {
      key: "progress",
      kind: "progress",
      summary: "Committing",
      reached_by: "Aldric",
    });
    expect(progress.reason).toBe("milestone-mismatch");
    await onlyRefusalsSince(before);

    // Quill's own work reaches the first; its lead's commit, named by name, reaches the second.
    await done(QUILL, quill, "report_checkpoint", {
      key: "drafted",
      kind: "milestone",
      summary: "Copy drafted",
      milestone_id: drafted.id,
    });
    const reached = await done(QUILL, quill, "report_checkpoint", {
      key: "committed",
      kind: "milestone",
      summary: "Committed",
      milestone_id: committed.id,
      reached_by: "aldric",
    });
    expect(reached.details.reached_by).toBe(ALDRIC);
    expect(reached.message).toContain(`reached by hob ${ALDRIC}`);
    const milestones = (await tree()).milestones.filter((each) => each.taskId === quill);
    expect(milestones.map(({ title, reachedBy }) => ({ title, reachedBy }))).toEqual([
      { title: "Copy drafted", reachedBy: QUILL },
      { title: "Committed", reachedBy: ALDRIC },
    ]);
    const recorded = await run(
      Effect.flatMap(Effect.service(EventJournal), (journal) => journal.readAfter(before.sequence)),
    );
    expect(JSON.stringify(recorded.filter((entry) => entry.type === "CheckpointRecorded").at(-1))).toContain(
      `"reachedBy":"${ALDRIC}"`,
    );
  });

  // covers OR-001, OR-002 (#1219)
  it("[TC-OR-1219-01] a lead's own milestone is never credited to a member it leads, nor to a hob beside it", async () => {
    await run(seed);
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy", { milestones: ["Review written"] });
    await delegate(ALDRIC, TOP, "Rook", "art");
    // Quill leads a nested Quest of its own: Pip works under Quill's Task.
    await delegate(QUILL, quill, "Pip", "proofread");
    const [review] = (await tree()).milestones.filter((each) => each.taskId === quill);
    if (review === undefined) throw new Error("expected a milestone");

    const before = await head();
    for (const [key, named] of [
      ["member", "Pip"],
      ["beside", "Rook"],
    ] as const) {
      const refusal = await refused(QUILL, quill, "report_checkpoint", {
        key,
        kind: "milestone",
        summary: "Review written",
        milestone_id: review.id,
        reached_by: named,
      });
      expect(refusal.reason).toBe("milestone-mismatch");
      expect(refusal.message).toContain(`${named} does not lead Task ${quill}`);
      expect(refusal.message).toContain("leave reached_by out");
    }
    await onlyRefusalsSince(before);

    await done(QUILL, quill, "report_checkpoint", {
      key: "own",
      kind: "milestone",
      summary: "Review written",
      milestone_id: review.id,
    });
    const milestones = (await tree()).milestones.filter((each) => each.taskId === quill);
    expect(milestones.map(({ title, reachedBy }) => ({ title, reachedBy }))).toEqual([
      { title: "Review written", reachedBy: QUILL },
    ]);
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
    expect(await onlyRefusalsSince(before)).toHaveLength(5);
    // A key that only ever led to refusals is still free.
    const planned = await done(ALDRIC, TOP, "plan_steps", { key: "k", steps: [{ brief: "Now it works" }] });
    const [step] = planned.details.steps as Array<{ readonly task_id: string }>;
    // A step that has not started has no result to return.
    const unstarted = await refused(ALDRIC, TOP, "complete_task", {
      delivered: true,
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
    await onlyRefusalsSince(before);
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

  // covers IN-003, OR-001
  it("[TC-IN-166] a turn whose backpack claim ran out or passed to another turn writes nothing through any hob tool", async () => {
    await run(seed);
    const quill = await delegate(ALDRIC, TOP, "Quill", "copy");
    const [item] = await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: QUILL })));
    if (item === undefined) throw new Error("expected Quill's Task in her backpack");
    const claimFor = (owner: string) =>
      run(Backpack.use((backpack) => backpack.claim(item.id, owner, "1 minute"))).then(
        ({ value }): CarriedItem => ({ itemId: value.id, owner, token: value.fencingToken }),
      );
    const fenced = (held: CarriedItem, name: TaskToolName, input: object) =>
      Effect.flatMap(Effect.service(TaskTools), (tools) =>
        tools.call({ agentId: QUILL, taskId: quill, carried: [held] }, name, input),
      );

    // While the claim holds, the turn's calls go through.
    const first = await claimFor("hub:turn-1");
    await run(fenced(first, "report_checkpoint", { key: "live", kind: "progress", summary: "Drafting" }));

    // The lease runs out: the item goes back to pending, with a new token.
    await run(Backpack.use((backpack) => backpack.expireClaims({ all: true })));
    const writes: Record<TaskToolName, object> = {
      plan_steps: { key: "s-plan", steps: [{ brief: "Outline" }] },
      start_quest: { key: "s-quest", goal: "Ship the copy" },
      delegate_task: { key: "s-delegate", hob: "Ada", brief: "Review the copy" },
      report_checkpoint: { key: "s-checkpoint", kind: "blocker", summary: "Stuck" },
      ask: { key: "s-ask", question: "Which tone?" },
      answer: { key: "s-answer", question_id: "q-1", answer: "Friendly" },
      escalate: { key: "s-escalate", question_id: "q-1" },
      hand_off: { key: "s-hand-off", artifact_id: "a-1", to_task_id: String(TOP) },
      wait_for: { key: "s-wait", tasks: [String(TOP)] },
      read_tasks: { key: "s-read" },
      message_task: { key: "s-message", task_id: String(TOP), text: "Go on" },
      complete_task: { key: "s-complete", summary: "The copy is ready" },
      cancel_task: { key: "s-cancel", task_id: String(TOP) },
      stop_quest: { key: "s-stop", reason: "You asked", summary: "Nothing delivered" },
      check_criterion: { key: "s-criterion", criterion_id: "c-1", verdict: "needs-rework", reason: "Not yet" },
      claim: { key: "s-claim", scope: "path", path: "README.md" },
    };
    const before = await head();
    const tasksBefore = (await tree()).tasks;
    for (const [name, input] of Object.entries(writes) as Array<[TaskToolName, object]>) {
      const refusal = await run(Effect.flip(fenced(first, name, input)));
      expect([name, refusal.reason]).toEqual([name, "claim-stale"]);
      expect(refusal.message).toContain(String(item.id));
    }
    // A retried key is refused too: the stale turn no longer holds its work.
    expect(
      (
        await run(
          Effect.flip(fenced(first, "report_checkpoint", { key: "live", kind: "progress", summary: "Drafting" })),
        )
      ).reason,
    ).toBe("claim-stale");

    await onlyRefusalsSince(before);
    expect((await tree()).tasks).toEqual(tasksBefore);
    expect((await tree()).delegations).toHaveLength(1);

    // Another turn claims the item: the first turn's claim stays stale, and the new one's calls go through.
    const second = await claimFor("hub:turn-2");
    expect((await run(Effect.flip(fenced(first, "delegate_task", writes.delegate_task)))).reason).toBe("claim-stale");
    expect((await tree()).tasks).toEqual(tasksBefore);
    await run(fenced(second, "delegate_task", writes.delegate_task));
    expect((await tree()).tasks.map((task) => task.ownerId)).toEqual([ALDRIC, QUILL, ADA]);
  });
});

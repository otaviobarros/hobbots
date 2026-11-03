import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  HobbotsRepository,
  HobTools,
  RuntimeAdapter,
  type RuntimeEvent,
  SecretRedaction,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  type CarriedItem,
  type EventEnvelope,
  MessageId,
  type TaskId,
  TaskId as TaskIdSchema,
  type TaskToolDone,
  type TaskToolRefused,
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
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Every Task tool call the hub refuses is recorded, journaled and shown (#575), against a real
// database: SQLite here, and PostgreSQL under `pnpm test:pg` (STD-TEST-006).

const now = "2026-11-01T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const ROOK = AgentId.make("rook");
const PIP = AgentId.make("pip");
const SAM = AgentId.make("sam");
const threadId = ThreadId.make("t1");
const TOP = TaskIdSchema.make("top");
/** A credential the hub knows by value, as one from its environment. */
const KNOWN_TOKEN = "hobbots-known-credential-0123456789";

let work: string;

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
  BackpackLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));
const App = TaskTools.layer(sep === "\\" ? "\\" : "/", {
  maxDepth: 2,
  maxOpenTasksPerHob: 2,
  maxOpenTasksPerTree: 10,
}).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Persistence,
      EventBus.layer,
      NodeFolderChecks,
      TestHobTools,
      FakeRuntimeLayer(),
      SecretRedaction.layer([{ value: KNOWN_TOKEN, kind: "DEPLOY_TOKEN" }]),
    ),
  ),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-refused-calls-")));
  runtime = ManagedRuntime.make(App);
});

afterEach(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof App>>) => runtime.runPromise(effect);

/** Frodo leads; Rook, Pip and Sam can join. You asked Frodo for the Quest, and his Task has started. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [FRODO, "Frodo"],
    [ROOK, "Rook"],
    [PIP, "Pip"],
    [SAM, "Sam"],
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
      }),
    );
  }
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: FRODO, title: "Quest", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  const created = yield* tasks.createTask({
    task: { id: TOP, ownerId: FRODO, parentId: null, threadId, brief: "The Quest", dependsOn: [], createdAt: now },
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

const call = (agentId: AgentId, taskId: TaskId, name: string, input: unknown, carried?: ReadonlyArray<CarriedItem>) =>
  Effect.flatMap(Effect.service(TaskTools), (tools) =>
    tools.call({ agentId, taskId, ...(carried === undefined ? {} : { carried }) }, name, input),
  );

const done = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
  run(call(agentId, taskId, name, input)) as Promise<TaskToolDone>;

const refused = (
  agentId: AgentId,
  taskId: TaskId,
  name: string,
  input: unknown,
  carried?: ReadonlyArray<CarriedItem>,
) => run(Effect.flip(call(agentId, taskId, name, input, carried))) as Promise<TaskToolRefused>;

const delegate = async (agentId: AgentId, taskId: TaskId, hob: string, key: string) =>
  TaskIdSchema.make(
    String((await done(agentId, taskId, "delegate_task", { key, hob, brief: `Work for ${hob}` })).details.task_id),
  );

interface StoredRefusal {
  readonly agentId: string;
  readonly callKey: string | null;
  readonly taskId: string | null;
  readonly tool: string;
  readonly input: string;
  readonly reason: string;
  readonly message: string;
  readonly tries: unknown;
}

const stored = () =>
  run(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<StoredRefusal>`SELECT * FROM task_tool_refusals ORDER BY created_at, reason, id`,
    ),
  );

const tree = () =>
  run(Effect.flatMap(Effect.service(TaskRepository), (tasks) => tasks.readTree(TOP))).then((found) =>
    Option.getOrThrow(found),
  );

/** Rook asks Frodo a question, and Frodo passes it up to you: the user owns it now. */
const escalatedQuestion = async () => {
  const rook = await delegate(FRODO, TOP, "Rook", "rook");
  const asked = await done(ROOK, rook, "ask", { key: "q", question: "Which colour for the banner?" });
  await done(FRODO, TOP, "escalate", { key: "up", question_id: asked.details.question_id });
  return { rook, questionId: String(asked.details.question_id) };
};

describe("refused Task tool calls", () => {
  // covers OR-003, OR-007
  it("[TC-OR-303] a lead's answer to a question the user owns is refused, recorded once, and announced", async () => {
    await run(seed);
    const { questionId } = await escalatedQuestion();
    const answer = { key: "answer-1", question_id: questionId, answer: "Blue" };

    const announced: Array<EventEnvelope> = [];
    const first = await run(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const subscription = yield* bus.subscribe;
        const refusal = yield* Effect.flip(call(FRODO, TOP, "answer", answer));
        const next = yield* PubSub.take(subscription);
        if (next._tag === "Journaled") announced.push(next.entry);
        return refusal;
      }).pipe(Effect.scoped),
    );
    expect(first.reason).toBe("not-recipient");
    // The hob is told who owns the question, so it never says the answer is on its way.
    expect(first.message).toContain("passed up to the user");
    expect(first.message).toContain("Your answer was not sent.");
    expect(announced.map((entry) => entry.type)).toEqual(["ToolCallRefused"]);

    // Retried with the same key, it is decided again: the same refusal, still one record.
    const again = await refused(FRODO, TOP, "answer", answer);
    expect(again).toEqual(first);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: FRODO,
      callKey: "answer-1",
      taskId: TOP,
      tool: "answer",
      reason: "not-recipient",
      message: first.message,
    });
    expect(Number(rows[0]?.tries)).toBe(2);
    expect(JSON.parse(String(rows[0]?.input))).toMatchObject({ question_id: questionId, answer: "Blue" });

    // The Task's tree carries the refusal, for the Workbench Summary.
    expect((await tree()).refusals).toEqual([
      expect.objectContaining({ taskId: TOP, tool: "answer", reason: "not-recipient", tries: 2 }),
    ]);
  });

  // covers OR-004, OR-005, OR-007
  it("[TC-OR-304] every way a call can be refused produces a record with its code and message", async () => {
    await run(seed);
    const rook = await delegate(FRODO, TOP, "Rook", "rook");
    const pip = await delegate(ROOK, rook, "Pip", "pip");
    const answers: Array<readonly [AgentId, TaskId, string, unknown]> = [
      // Before the ledger: no such tool, and input that does not decode, with or without a key.
      [FRODO, TOP, "summon_army", { key: "army" }],
      [FRODO, TOP, "plan_steps", { key: "empty", steps: [] }],
      [FRODO, TOP, "plan_steps", { steps: [{ brief: "No key" }] }],
      // The Task the turn names.
      [FRODO, TaskIdSchema.make("nowhere"), "report_checkpoint", { key: "lost", kind: "progress", summary: "x" }],
      [ROOK, TOP, "report_checkpoint", { key: "theirs", kind: "progress", summary: "x" }],
      // The call's own checks.
      [FRODO, TOP, "delegate_task", { key: "nobody", hob: "Nobody", brief: "x" }],
      [ROOK, rook, "delegate_task", { key: "self", hob: "rook", brief: "x" }],
      [ROOK, rook, "delegate_task", { key: "back", hob: "Frodo", brief: "x" }],
      [PIP, pip, "delegate_task", { key: "deep", hob: "Sam", brief: "x" }],
      [FRODO, TOP, "delegate_task", { key: "more", hob: "Rook", brief: "x" }],
      [ROOK, rook, "cancel_task", { key: "up", task_id: TOP }],
      [ROOK, rook, "hand_off", { key: "give", artifact_id: "a-1", to_task_id: pip }],
      [FRODO, TOP, "answer", { key: "q", question_id: "missing", answer: "x" }],
      // The ledger: the same key for another call.
      [ROOK, rook, "delegate_task", { key: "pip", hob: "Sam", brief: "Another" }],
    ];
    // Rook already has two open Tasks of the limit of two, so a third for him is refused.
    await delegate(FRODO, TOP, "Rook", "rook-2");
    const told: Array<TaskToolRefused> = [];
    for (const [agentId, taskId, name, input] of answers) told.push(await refused(agentId, taskId, name, input));

    // A turn whose backpack claim ran out.
    const [item] = await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: PIP })));
    if (item === undefined) throw new Error("expected Pip's Task in his backpack");
    const claim = await run(Backpack.use((backpack) => backpack.claim(item.id, "hub:turn-1", "1 minute")));
    await run(Backpack.use((backpack) => backpack.expireClaims({ all: true })));
    const held: CarriedItem = { itemId: claim.value.id, owner: "hub:turn-1", token: claim.value.fencingToken };
    told.push(await refused(PIP, pip, "report_checkpoint", { key: "stale", kind: "progress", summary: "x" }, [held]));

    // A tool the turn does not offer.
    const offered = await run(
      Effect.map(Effect.service(TaskTools), (tools) => tools.forTurn({ agentId: FRODO, taskId: TOP }, ["ask"])),
    );
    const notOffered = await run(offered.call("plan_steps", { key: "hidden", steps: [{ brief: "x" }] }));
    expect(notOffered.refused).toBe(true);

    const reasons = told.map((each) => each.reason);
    expect(reasons).toEqual([
      "unknown-tool",
      "invalid-input",
      "invalid-input",
      "task-missing",
      "not-owner",
      "hob-missing",
      "own-hob",
      "cycle",
      "depth-limit",
      "concurrency-limit",
      "outside-subtree",
      "artifact-missing",
      "question-missing",
      "key-reused",
      "claim-stale",
    ]);
    const rows = await stored();
    expect(rows).toHaveLength(told.length + 1);
    // Each refusal the hob read is on record, as it read it.
    for (const refusal of told) {
      expect(rows).toContainEqual(expect.objectContaining({ reason: refusal.reason, message: refusal.message }));
    }
    expect(rows).toContainEqual(
      expect.objectContaining({
        agentId: FRODO,
        callKey: "hidden",
        taskId: TOP,
        tool: "plan_steps",
        reason: "unknown-tool",
      }),
    );
    // A call with no key is its own record; one with a key the ledger already holds keeps that key.
    expect(rows).toContainEqual(expect.objectContaining({ callKey: null, reason: "invalid-input" }));
    expect(rows).toContainEqual(expect.objectContaining({ agentId: ROOK, callKey: "pip", reason: "key-reused" }));
    expect(rows).toContainEqual(expect.objectContaining({ agentId: FRODO, taskId: "nowhere", reason: "task-missing" }));
  });

  // covers OR-007
  it("[TC-OR-305] a refused call's reply step ends as failed, with what the hob was told", async () => {
    await run(seed);
    const { questionId } = await escalatedQuestion();
    const prompt = [
      "Answer Rook",
      `fake:hub answer {"key":"answer-1","question_id":"${questionId}","answer":"Blue"}`,
      'fake:hub report_checkpoint {"key":"p","kind":"progress","summary":"Under way"}',
    ].join("\n");
    const events = (await run(
      Effect.gen(function* () {
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
            hubTools: tools.forTurn({ agentId: FRODO, taskId: TOP }),
          }),
        );
      }),
    )) as ReadonlyArray<RuntimeEvent>;
    const finished = events.filter((event) => event._tag === "ToolFinished");
    expect(finished).toEqual([
      expect.objectContaining({
        id: "fake-hub-1",
        failed: true,
        output: expect.stringContaining("only the user answers it now"),
      }),
    ]);
    // The call that went through ends as done, with no failure reported for it.
    expect(events).toContainEqual({ _tag: "StepEnded", id: "fake-hub-2" });
  });
  // covers OR-007, PE-001
  it("[TC-OR-307] a refusal is redacted before it is stored, journaled or announced", async () => {
    await run(seed);
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const announced: Array<EventEnvelope> = [];
    const refusal = await run(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const subscription = yield* bus.subscribe;
        const told = yield* Effect.flip(
          call(FRODO, TOP, "delegate_task", {
            key: "leak",
            hob: KNOWN_TOKEN,
            brief: `Deploy with ${KNOWN_TOKEN}, and send Authorization: ${bearer}`,
          }),
        );
        const next = yield* PubSub.take(subscription);
        if (next._tag === "Journaled") announced.push(next.entry);
        return told;
      }).pipe(Effect.scoped),
    );
    // The hob still reads what it sent; only the record is redacted.
    expect(refusal.reason).toBe("hob-missing");
    expect(refusal.message).toContain(KNOWN_TOKEN);

    const rows = await stored();
    const journal = await run(Effect.flatMap(Effect.service(EventJournal), (each) => each.readAfter(0)));
    const everywhere = JSON.stringify([rows, journal, announced]);
    expect(everywhere).not.toContain(KNOWN_TOKEN);
    expect(everywhere).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(rows[0]?.input).toContain("[redacted: DEPLOY_TOKEN]");
    expect(rows[0]?.message).toContain("[redacted: DEPLOY_TOKEN]");
    expect(announced.map((entry) => entry.type)).toEqual(["ToolCallRefused"]);
  });

  // covers OR-007
  it("[TC-OR-308] a chat turn's refusal before its call is decided is recorded on the Task it was briefed on", async () => {
    await run(seed);
    const chatTurn = (thread: ThreadId, message: string) =>
      run(
        Effect.flatMap(Effect.service(TaskTools), (tools) =>
          tools.forChat({
            agentId: FRODO,
            threadId: thread,
            messageId: MessageId.make(message),
            prompt: "Carry on with the Quest",
            runtime: "claude-code",
            configVersion: 1,
          }),
        ),
      );
    const briefed = await chatTurn(threadId, "reply-1");
    for (const [name, input] of [
      ["summon_army", { key: "army" }],
      ["plan_steps", { steps: [] }],
      ["report_checkpoint", { key: "p", kind: "progress", summary: "Under way" }],
      ["report_checkpoint", { key: "p", kind: "progress", summary: "Something else" }],
    ] as const) {
      await run(briefed.hubTools.call(name, input));
    }
    const rows = await stored();
    expect(rows.map((row) => [row.reason, row.taskId]).sort()).toEqual([
      ["invalid-input", TOP],
      ["key-reused", TOP],
      ["unknown-tool", TOP],
    ]);
    expect((await tree()).refusals).toHaveLength(3);

    // In a thread with no Task yet, a refused call that would start one leaves none, and no Task on its record.
    const elsewhere = ThreadId.make("t2");
    await run(
      Effect.flatMap(Effect.service(HobbotsRepository), (repo) =>
        repo.upsertThread(
          new Thread({ id: elsewhere, agentId: FRODO, title: "Other", createdAt: now, updatedAt: now }),
        ),
      ),
    );
    const fresh = await chatTurn(elsewhere, "reply-2");
    const answer = await run(fresh.hubTools.call("delegate_task", { key: "d", hob: "Nobody", brief: "x" }));
    expect(answer.refused).toBe(true);
    const missing = (await stored()).find((row) => row.callKey === "d");
    expect(missing).toMatchObject({ reason: "hob-missing", taskId: null });
    expect(
      await run(Effect.flatMap(Effect.service(TaskRepository), (tasks) => tasks.readThreadTrees(elsewhere))),
    ).toEqual([]);
  });
});

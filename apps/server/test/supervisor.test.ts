import { HobbotsRepository, TaskControls, TaskRepository } from "@hobbots/agents";
import { Agent, AgentId, AttemptId, type RuntimeKind, type Task, TaskId, type TaskTree } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { HobbotsRepositoryLive, SupervisionRecordsLive, TaskRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Supervisor } from "@hobbots/supervision";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { hub, isLive, NETTLE, ownedBy, PIP, partyHub, send, threadId, treeWhen } from "./party-hub.ts";

// Issue #1447: the supervisor stops a member past its deadline and tells its lead, and fails a
// member whose runtime ran out of allowance, ending the work under it first, with no model call.
// Each runs on every runtime a member can run on, played by the fake.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

/** No turn is running on Pip's Task. */
const idle = (tree: TaskTree) => {
  const task = ownedBy(tree, PIP);
  return task !== undefined && !tree.attempts.some((each) => each.taskId === task.id && isLive(each.state));
};

/** Pip's Task in the request's tree as it is now. */
const pipTask = Effect.map(
  TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)),
  ([tree]) => (tree === undefined ? undefined : ownedBy(tree, PIP)),
);

/** Looks over the work as at `at` until Pip's Task has failed, as the supervisor does on its schedule. */
const passUntilFailed = (at?: string) =>
  waitUntil(
    Effect.andThen(
      Supervisor.use((supervisor) => supervisor.pass(at)),
      pipTask,
    ),
    (task): task is Task => task?.state === "failed",
    { what: "Pip's Task to fail" },
  );

describe.each(RUNTIMES)("the supervisor, with members on %s", (members) => {
  // covers OR-005, EX-003
  it("[TC-OR-1447-10] stops a member past its deadline, fails its Task, and tells its lead why", async () => {
    const party = partyHub({ members, supervisor: true });
    dispose = party.dispose;
    const { run, requests, gates } = party;
    // Pip's turn holds on its first call, so it is still running when its deadline passes.
    gates.set("stall", () => new Promise<void>(() => undefined));
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          timeout_minutes: 1,
          brief: ["Review the project", hub("report_checkpoint", { key: "stall", kind: "finding", summary: "x" })].join(
            "\n",
          ),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const started = await run(
      treeWhen((tree) => {
        const task = ownedBy(tree, PIP);
        return task !== undefined && tree.attempts.some((each) => each.taskId === task.id && isLive(each.state));
      }),
    );
    const pip = ownedBy(started, PIP);
    const delegation = started.delegations.find((each) => each.childTaskId === pip?.id);
    if (pip === undefined || delegation?.timeoutMs == null) throw new Error("no Task with a time limit for Pip");
    const later = new Date(Date.parse(delegation.createdAt) + delegation.timeoutMs + 60_000).toISOString();

    // Nothing is overdue yet: the supervisor leaves the running turn alone.
    expect((await run(Supervisor.use((supervisor) => supervisor.pass()))).acted).toEqual([]);

    await run(passUntilFailed(later));
    const ended = await run(treeWhen(idle));
    expect(ended.attempts.filter((each) => each.taskId === pip.id).map((each) => each.state)).toEqual(["interrupted"]);
    // Frodo, its lead, reads why in the turn its failure wakes.
    await run(
      waitUntil(
        Effect.sync(() => requests.some((each) => each.prompt.includes("passed its deadline"))),
        (told) => told,
        { what: "Frodo to be told" },
      ),
    );
  }, 30_000);

  // covers OR-005, OR-006
  it("[TC-OR-1447-14] leaves work you paused alone past its deadline, and stops it once you resume it", async () => {
    const party = partyHub({ members, supervisor: true });
    dispose = party.dispose;
    const { run, gates } = party;
    gates.set("stall", () => new Promise<void>(() => undefined));
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          timeout_minutes: 1,
          brief: ["Review the project", hub("report_checkpoint", { key: "stall", kind: "finding", summary: "x" })].join(
            "\n",
          ),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const started = await run(treeWhen((tree) => ownedBy(tree, PIP) !== undefined && !idle(tree)));
    const pip = ownedBy(started, PIP);
    const delegation = started.delegations.find((each) => each.childTaskId === pip?.id);
    if (pip === undefined || delegation?.timeoutMs == null) throw new Error("no Task with a time limit for Pip");
    const later = new Date(Date.parse(delegation.createdAt) + delegation.timeoutMs + 60_000).toISOString();
    // You pause it at once: its turn stops, and the Task waits for you.
    await run(TaskControls.use((controls) => controls.pause(pip.id, true)));
    await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "paused" && idle(tree)));
    expect((await run(Supervisor.use((supervisor) => supervisor.pass(later)))).acted).toEqual([]);
    expect((await run(pipTask))?.state).toBe("paused");
    // Resumed, it is past its deadline again, so the supervisor ends it.
    await run(TaskControls.use((controls) => controls.resume(pip.id)));
    await run(passUntilFailed(later));
  }, 30_000);

  // covers OR-006, IN-007
  it("[TC-OR-1447-11] fails a member out of allowance whose own member still works, ending that work first", async () => {
    const party = partyHub({ members, supervisor: true });
    dispose = party.dispose;
    const { run, gates } = party;
    // Nettle's turn holds on its first call, so it still runs when Pip's allowance runs out.
    gates.set("stall", () => new Promise<void>(() => undefined));
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review the project",
            hub("delegate_task", {
              key: "lint",
              hob: "Nettle",
              brief: [
                "Lint the project",
                hub("report_checkpoint", { key: "stall", kind: "finding", summary: "x" }),
              ].join("\n"),
            }),
            "fake:limit",
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    await run(
      treeWhen((tree) => {
        const nettle = ownedBy(tree, NETTLE);
        return nettle !== undefined && tree.attempts.some((each) => each.taskId === nettle.id && isLive(each.state));
      }),
    );
    await run(passUntilFailed());
    const ended = await run(treeWhen((tree) => idle(tree) && ownedBy(tree, NETTLE)?.state === "failed"));
    const nettle = ownedBy(ended, NETTLE);
    // Nettle's turn was stopped, and her Task failed before Pip's, which carries the reason.
    expect(ended.attempts.filter((each) => each.taskId === nettle?.id).map((each) => each.state)).toEqual([
      "interrupted",
    ]);
  }, 30_000);

  // covers OR-006, IN-007
  it("[TC-OR-1447-12] fails a member whose runtime ran out of allowance, and says when it resets", async () => {
    const party = partyHub({ members, supervisor: true });
    dispose = party.dispose;
    const { run, requests } = party;
    await run(
      send([
        "Review the project",
        hub("delegate_task", { key: "review", hob: "Pip", brief: ["Review the project", "fake:limit"].join("\n") }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    await run(passUntilFailed());
    const ended = await run(treeWhen(idle));
    const pip = ownedBy(ended, PIP);
    // The supervisor stopped it after the one turn the limit ended: nothing tried it again.
    expect(ended.attempts.filter((each) => each.taskId === pip?.id).map((each) => each.state)).toEqual(["failed"]);
    await run(
      waitUntil(
        Effect.sync(() => requests.some((each) => each.prompt.includes("The usage limit of hob"))),
        (told) => told,
        { what: "Frodo to be told" },
      ),
    );
  }, 30_000);
});

describe("the supervisor's retries", () => {
  const now = "2026-11-14T10:00:00.000Z";
  const FRODO = AgentId.make("frodo");
  const ROOT = TaskId.make("root");
  const PAGE = TaskId.make("page");
  const hob = (id: AgentId, name: string) =>
    new Agent({
      id,
      name,
      roleTitle: "Engineer",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    });
  const records = Layer.mergeAll(
    TaskRepositoryLive,
    HobbotsRepositoryLive,
    SupervisionRecordsLive,
    EventBus.layer,
  ).pipe(Layer.provideMerge(TestDatabase));

  /** A step of Frodo's under his Task, whose one turn failed and which failed with it. */
  const seed = Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const tasks = yield* TaskRepository;
    yield* repo.insertAgent(hob(FRODO, "Frodo"));
    const task = (id: TaskId, ownerId: AgentId, parentId: TaskId | null) =>
      tasks.createTask({
        task: { id, ownerId, parentId, threadId: null, brief: id, dependsOn: [], createdAt: now },
        delegation: null,
        milestones: [],
      });
    const root = yield* task(ROOT, FRODO, null);
    yield* tasks.startAttempt(ROOT, root.value.revision, {
      id: AttemptId.make("root-1"),
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: now,
    });
    const page = yield* task(PAGE, FRODO, ROOT);
    yield* tasks.startAttempt(PAGE, page.value.revision, {
      id: AttemptId.make("page-1"),
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: now,
    });
    const ended = yield* tasks.updateAttempt(AttemptId.make("page-1"), {
      _tag: "Ended",
      end: { _tag: "Failed", reason: "The runtime ended without a result." },
      at: now,
    });
    if (ended.value.task.state !== "failed") {
      yield* tasks.moveTask(PAGE, ended.value.task.revision, "failed", now);
    }
  }).pipe(Effect.orDie);

  const passWith = (limits: { readonly maxOpenTasksPerHob: number; readonly maxOpenTasksPerTree: number }) =>
    Effect.provide(
      Supervisor.use((supervisor) => supervisor.pass(now)),
      Supervisor.layer({ every: null, limits }),
    );

  // covers OR-004, EX-004
  it("[TC-OR-1447-15] retries a failed Task only while its hob and its tree have room for it", async () => {
    const runtime = ManagedRuntime.make(records);
    dispose = () => runtime.dispose();
    await runtime.runPromise(seed);
    const state = () =>
      runtime.runPromise(
        Effect.map(
          TaskRepository.use((tasks) => tasks.readTree(ROOT)),
          (tree) => Option.getOrThrow(tree).tasks.find((each) => each.id === PAGE)?.state,
        ),
      );
    // The tree holds one open Task, its top one, and may hold no more: the retry waits.
    expect((await runtime.runPromise(passWith({ maxOpenTasksPerHob: 4, maxOpenTasksPerTree: 1 }))).acted).toEqual([]);
    expect(await state()).toBe("failed");
    // Frodo may hold no more open Tasks: the retry waits too.
    expect((await runtime.runPromise(passWith({ maxOpenTasksPerHob: 1, maxOpenTasksPerTree: 10 }))).acted).toEqual([]);
    // With room, it is retried.
    expect((await runtime.runPromise(passWith({ maxOpenTasksPerHob: 4, maxOpenTasksPerTree: 10 }))).acted).toEqual([
      "Retry",
    ]);
    expect(await state()).toBe("queued");
  });
});

import { sep } from "node:path";
import { HobbotsRepository, HobTools, TaskRepository } from "@hobbots/agents";
import { Agent, type AgentId, AttemptId, type TaskId, type TaskToolDone, Thread, ThreadId } from "@hobbots/domain";
import { TaskTools } from "@hobbots/orchestration";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// The hob tools alone against a real database, with no runtime and no dispatcher: a call does only
// what the hub records, so a test reads exactly what each call wrote.

const now = "2026-11-03T00:00:00.000Z";

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null as never) }));

const Tools = TaskTools.layer(sep === "\\" ? "\\" : "/").pipe(
  Layer.provideMerge(
    Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive, EventJournal.layer).pipe(
      Layer.provideMerge(TestDatabase),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(EventBus.layer, NodeFolderChecks, NoTools)),
);

/**
 * Hobs named `names`, and a request to the first of them in its thread, `top`, whose turn has
 * started. `call` makes a hob's call from a turn on a Task, `refused` one the hub refuses.
 */
export const toolsHub = (names: ReadonlyArray<readonly [AgentId, string]>, top: TaskId) => {
  const runtime = ManagedRuntime.make(Tools);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof Tools>>) => runtime.runPromise(effect);
  const make = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
    Effect.flatMap(Effect.service(TaskTools), (tools) => tools.call({ agentId, taskId }, name, input));
  const call = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
    run(make(agentId, taskId, name, input)) as Promise<TaskToolDone>;
  const refused = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
    run(Effect.flip(make(agentId, taskId, name, input)));
  const head = () => run(Effect.flatMap(Effect.service(EventJournal), (journal) => journal.head));
  /** The types journaled after `before`: a refused call records only its refusal (#575). */
  const journaledSince = async (before: { readonly sequence: number }) =>
    (await run(Effect.flatMap(Effect.service(EventJournal), (journal) => journal.readAfter(before.sequence)))).map(
      (entry) => entry.type,
    );
  const tree = () =>
    run(Effect.flatMap(Effect.service(TaskRepository), (tasks) => tasks.readTree(top))).then(Option.getOrThrow);
  /** Starts a turn on `taskId`, at its `revision`, as its first Attempt. */
  const startTurn = (taskId: TaskId, revision: number) =>
    Effect.flatMap(Effect.service(TaskRepository), (tasks) =>
      tasks.startAttempt(taskId, revision, {
        id: AttemptId.make(`${taskId}-1`),
        runtime: "claude-code",
        sessionId: null,
        configVersion: 1,
        policyVersion: null,
        startedAt: now,
      }),
    );
  const seed = Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const [id, name] of names) {
      yield* repo.insertAgent(
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
        }),
      );
    }
    const [lead] = names;
    if (lead === undefined) return;
    const threadId = ThreadId.make("tools-hub");
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: lead[0], title: "Work", createdAt: now, updatedAt: now }),
    );
    const tasks = yield* TaskRepository;
    const created = yield* tasks.createTask({
      task: {
        id: top,
        ownerId: lead[0],
        parentId: null,
        threadId,
        brief: "Build the project",
        dependsOn: [],
        createdAt: now,
      },
      delegation: null,
      milestones: [],
    });
    yield* startTurn(top, created.value.revision);
  });
  return { run, call, refused, head, journaledSince, tree, seed, startTurn, dispose: () => runtime.dispose() };
};

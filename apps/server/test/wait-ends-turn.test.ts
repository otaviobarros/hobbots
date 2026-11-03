import { sep } from "node:path";
import { HobbotsRepository, HobTools, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  MessageId,
  type TaskId,
  TaskId as TaskIdSchema,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { TaskTools } from "@hobbots/orchestration";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #572: wait_for does not block, so a hob that read "keep working meanwhile" called it again
// and again in one turn, and its Task showed waiting while that turn still ran. A wait now tells the
// hob to end its turn, a repeated wait records nothing, and the Task waits only once its turn ends.

const now = "2026-11-03T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("first-run");

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null as never) }));

const App = TaskTools.layer(sep === "\\" ? "\\" : "/").pipe(
  Layer.provideMerge(
    Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive, EventJournal.layer).pipe(
      Layer.provideMerge(TestDatabase),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(EventBus.layer, NodeFolderChecks, NoTools)),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;
beforeEach(() => {
  runtime = ManagedRuntime.make(App);
});
afterEach(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof App>>) => runtime.runPromise(effect);

/** Frodo, who leads in his chat, and Pip, who he brings in. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [FRODO, "Frodo"],
    [PIP, "Pip"],
  ] as const) {
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
        policy: EMPTY_HOB_POLICY,
      }),
    );
  }
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: FRODO, title: "First run", createdAt: now, updatedAt: now }),
  );
});

/** A chat turn of Frodo's, as a message in his thread starts one. */
const chatTurn = (messageId: string) =>
  Effect.flatMap(Effect.service(TaskTools), (tools) =>
    tools.forChat({
      agentId: FRODO,
      threadId,
      messageId: MessageId.make(messageId),
      prompt: "Build the stdlib project with Pip",
      runtime: "claude-code",
      configVersion: 1,
    }),
  );

const head = () => run(Effect.flatMap(Effect.service(EventJournal), (journal) => journal.head));

const treeOf = (taskId: TaskId) =>
  run(Effect.flatMap(Effect.service(TaskRepository), (tasks) => tasks.readTree(taskId))).then(Option.getOrThrow);

describe("a wait ends the turn", () => {
  // covers OR-003
  it("[TC-OR-240] wait_for tells the hob to end its turn, and the same wait again in that turn records nothing", async () => {
    await run(seed);
    const turn = await run(chatTurn("m-1"));
    const delegated = await run(
      turn.hubTools.call("delegate_task", { key: "backend", hob: "Pip", brief: "Write the backend" }),
    );
    expect(delegated.refused).toBe(false);
    const details = JSON.parse(delegated.text.split("\n").at(-1) ?? "{}") as { readonly task_id: string };
    const pip = TaskIdSchema.make(details.task_id);

    const waited = await run(turn.hubTools.call("wait_for", { key: "wait-1", tasks: [pip] }));
    expect(waited.refused).toBe(false);
    expect(waited.text).toContain("End your turn now.");
    expect(waited.text).toContain("Hobbots wakes you when they end");
    expect(waited.text).not.toContain("keep working");

    // A hob that checks again, under a new key, reads that it already waits; nothing is journaled.
    const before = await head();
    for (const key of ["wait-2", "wait-3"]) {
      const again = await run(turn.hubTools.call("wait_for", { key, tasks: [pip], mode: "all" }));
      expect(again.refused).toBe(false);
      expect(again.text).toContain("already waits for these. End your turn now.");
    }
    expect(await head()).toEqual(before);
    const top = (await treeOf(pip)).tasks[0]?.parentId;
    if (top === undefined || top === null) throw new Error("no lead Task");
    expect((await treeOf(top)).waits).toEqual([expect.objectContaining({ on: [pip], mode: "all" })]);

    // Another wait is a new one, and replaces it.
    const any = await run(turn.hubTools.call("wait_for", { key: "wait-any", tasks: [pip], mode: "any" }));
    expect(any.text).not.toContain("already waits");
    expect(await head()).not.toEqual(before);
  });

  // covers OR-003, EX-002
  it("[TC-OR-241] the waiting Task stays active while its turn runs and shows waiting once the turn ends", async () => {
    await run(seed);
    const turn = await run(chatTurn("m-1"));
    const delegated = await run(
      turn.hubTools.call("delegate_task", { key: "backend", hob: "Pip", brief: "Write the backend" }),
    );
    const pip = TaskIdSchema.make(
      (JSON.parse(delegated.text.split("\n").at(-1) ?? "{}") as { readonly task_id: string }).task_id,
    );
    const top = (await treeOf(pip)).tasks[0]?.parentId;
    if (top === undefined || top === null) throw new Error("no lead Task");

    await run(turn.hubTools.call("wait_for", { key: "wait", tasks: [pip] }));
    const during = await treeOf(top);
    expect(during.tasks[0]?.state).toBe("active");
    // No automatic "waiting" checkpoint while the turn still runs.
    expect(during.checkpoints.filter((each) => each.taskId === top && each.kind === "waiting")).toEqual([]);

    await run(turn.end("completed", null));
    const after = await treeOf(top);
    expect(after.tasks[0]?.state).toBe("waiting");
    expect(after.checkpoints.filter((each) => each.taskId === top && each.kind === "waiting")).toHaveLength(1);

    // A later turn that waits for nothing new leaves it waiting when it ends too.
    const next = await run(chatTurn("m-2"));
    const again = await run(next.hubTools.call("wait_for", { key: "wait-later", tasks: [pip] }));
    expect(again.text).toContain("End your turn now.");
    await run(next.end("completed", null));
    expect((await treeOf(top)).tasks[0]?.state).toBe("waiting");
  });
});

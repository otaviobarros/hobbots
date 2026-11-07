import { sep } from "node:path";
import { HobbotsRepository, HobTools, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  type TaskId,
  TaskId as TaskIdSchema,
  type TaskToolDone,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { TaskTools } from "@hobbots/orchestration";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { continuations, FRODO, hub, messagesWhen, ownedBy, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// Issue #573: Nettle asked its lead Pip a question while Pip waited on Nettle, and nobody in the
// chain knew Nettle was waiting on Pip. wait_for now lists the questions and blockers the awaited
// Tasks have open, so the lead answers instead of waiting on itself, and a question from an awaited
// Task reaches the lead in the first turn after the one that waited.

const now = "2026-11-03T00:00:00.000Z";
const PIP = AgentId.make("pip");
const NETTLE = AgentId.make("nettle");
const TOP = TaskIdSchema.make("first-run");

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null as never) }));

const Tools = TaskTools.layer(sep === "\\" ? "\\" : "/").pipe(
  Layer.provideMerge(
    Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive, EventJournal.layer).pipe(
      Layer.provideMerge(TestDatabase),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(EventBus.layer, NodeFolderChecks, NoTools)),
);

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** The hob tools alone, with Pip leading Nettle's Task under his own, whose turn has started. */
const toolsOnly = () => {
  const runtime = ManagedRuntime.make(Tools);
  dispose = () => runtime.dispose();
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof Tools>>) => runtime.runPromise(effect);
  const call = (agentId: AgentId, taskId: TaskId, name: string, input: Record<string, unknown>) =>
    run(
      Effect.flatMap(Effect.service(TaskTools), (tools) => tools.call({ agentId, taskId }, name, input)),
    ) as Promise<TaskToolDone>;
  const seed = Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const [id, name] of [
      [PIP, "Pip"],
      [NETTLE, "Nettle"],
      [AgentId.make("quill"), "Quill"],
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
        }),
      );
    }
    const threadId = ThreadId.make("review");
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: PIP, title: "Review", createdAt: now, updatedAt: now }),
    );
    const tasks = yield* TaskRepository;
    const created = yield* tasks.createTask({
      task: { id: TOP, ownerId: PIP, parentId: null, threadId, brief: "Review", dependsOn: [], createdAt: now },
      delegation: null,
      milestones: [],
    });
    yield* tasks.startAttempt(TOP, created.value.revision, {
      id: AttemptId.make("pip-1"),
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: now,
    });
  });
  return { run, call, seed };
};

describe("waiting on a Task that asks", () => {
  // covers OR-002, OR-003, IN-004
  it("[TC-OR-243] wait_for lists the questions and blockers the awaited Tasks have open, and says to answer first", async () => {
    const { run, call, seed } = toolsOnly();
    await run(seed);
    const nettle = TaskIdSchema.make(
      String(
        (await call(PIP, TOP, "delegate_task", { key: "commit", hob: "Nettle", brief: "Commit" })).details.task_id,
      ),
    );
    const quill = TaskIdSchema.make(
      String((await call(PIP, TOP, "delegate_task", { key: "docs", hob: "Quill", brief: "Docs" })).details.task_id),
    );
    const asked = await call(NETTLE, nettle, "ask", { key: "q", question: "git init was denied. Can you run it?" });
    await call(AgentId.make("quill"), quill, "report_checkpoint", {
      key: "stuck",
      kind: "blocker",
      summary: "The docs folder is read-only",
    });

    const waited = await call(PIP, TOP, "wait_for", { key: "wait", tasks: [nettle, quill] });
    expect(waited.message).toContain("A question from them waits for you: answer each with answer");
    expect(waited.message).toContain("One of them is blocked: see blockers.");
    expect(waited.message).toContain("End your turn now.");
    expect(waited.details.questions).toEqual([
      {
        question_id: asked.details.question_id,
        task_id: nettle,
        asker: NETTLE,
        question: "git init was denied. Can you run it?",
        waits_for: "you",
      },
    ]);
    expect(waited.details.blockers).toEqual([{ task_id: quill, blocker: "The docs folder is read-only" }]);

    // The same wait again still says what is open; once answered and moved past, nothing is listed.
    const again = await call(PIP, TOP, "wait_for", { key: "wait-again", tasks: [nettle, quill] });
    expect(again.message).toContain("already waits for these. A question from them waits for you");
    await call(PIP, TOP, "answer", { key: "a", question_id: asked.details.question_id, answer: "Done, go on." });
    await call(AgentId.make("quill"), quill, "report_checkpoint", {
      key: "on",
      kind: "progress",
      summary: "Writing to a temp folder instead",
    });
    const clear = await call(PIP, TOP, "wait_for", { key: "wait-clear", tasks: [nettle, quill], mode: "any" });
    expect(clear.message).not.toContain("waits for you: answer");
    expect(clear.message).not.toContain("blocked");
    expect(clear.details.questions).toBeUndefined();
    expect(clear.details.blockers).toBeUndefined();
  });

  // covers OR-002, OR-003, IN-004
  it("[TC-OR-244] a question from an awaited Task reaches the waiting lead in the next turn after the one that waited, and is answered once", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, answers } = party;
    await run(
      send([
        "Plan the release",
        hub("delegate_task", {
          key: "copy",
          hob: "Quill",
          brief: [
            "Draft the copy",
            hub("ask", { key: "tone", question: "Playful or formal?" }),
            `fake:then ${hub("complete_task", { delivered: true, key: "copy-done", summary: "Playful copy drafted" })}`,
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
        // The turn after this one waits again, reads the question there, and answers it.
        `fake:then ${hub("wait_for", { key: "wait-again", tasks: ["$copy.task_id"] })}`,
        `fake:then ${hub("answer", { key: "reply", question_id: "$tone.question_id", answer: "Playful" })}`,
        `fake:then fake:then ${hub("complete_task", { delivered: true, key: "wrap", summary: "Release planned" })}`,
      ]),
    );

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const [question] = done.questions;
    expect(question?.askerId).toBe(QUILL);
    expect(question?.answeredBy).toEqual({ _tag: "Lead", agentId: FRODO });
    expect(ownedBy(done, QUILL)?.result?.summary).toBe("Playful copy drafted");
    expect(answers.get("wait-again")).toContain("A question from them waits for you");
    expect(answers.get("wait-again")).toContain("Playful or formal?");
    expect(answers.get("reply")).not.toContain("Refused");

    // The first turn after the one that waited carried the question; no later turn did again.
    const all = await run(messagesWhen((each) => continuations(each).length === 2));
    const [first, second] = continuations(all);
    expect(first?.content).toContain(`question ${question?.id} about Task`);
    expect(second?.content).not.toContain(`question ${question?.id} about Task`);
  }, 20_000);
});

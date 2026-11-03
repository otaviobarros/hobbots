import { HobLifecycle } from "@hobbots/agents";
import type { Message } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  attemptsOf,
  hold,
  hub,
  memberTask,
  messagesWhen,
  nothingOpen,
  promptsTo,
  QUILL,
  ROOK,
  send,
  settledTree,
  sharedDatabase,
  startHub,
  taskOf,
  treeWhen,
} from "./dependency-hub.ts";

// Issue #565: when the last Task a dependent comes after completes, the dependent goes on with no
// one outside the Quest stepping in. Its first turn starts then, with what the Tasks it comes after
// returned, so its lead's wait on it ends without a hand-off or a message from you (ADR 018).

const backend = hub("delegate_task", {
  key: "backend",
  hob: "Quill",
  brief: [
    "Write the backend",
    hold("quill"),
    hub("complete_task", {
      key: "backend-done",
      summary: "Stores amounts as integer cents",
      artifacts: [{ kind: "text", label: "core.py", value: "def total(cents): return sum(cents)" }],
    }),
  ].join("\n"),
});

/** Rook's frontend Task, after Quill's: it calls no tool, so its final reply is its result. */
const frontend = hub("delegate_task", {
  key: "frontend",
  hob: "Rook",
  brief: "Write the frontend",
  depends_on: ["$backend.task_id"],
});

/** Aldric wraps up once Rook's result reaches him. */
const wrapUp = {
  on: "(Write the frontend) finished",
  lines: [hub("complete_task", { key: "wrap", summary: "The app is built" })],
};

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

describe("a dependency that completes wakes its dependent", () => {
  // covers OR-002, OR-003, IN-004
  it("[TC-OR-207] Aldric waits on Rook; Quill's completion starts Rook's one turn with Quill's result, and the Quest finishes from your one message", async () => {
    const { run, requests, release } = await startHub(await sharedDatabase(), [wrapUp]);
    await run(
      send([
        "Build the app",
        backend,
        frontend,
        hub("wait_for", { key: "wait", tasks: ["$backend.task_id", "$frontend.task_id"] }),
      ]),
    );
    await run(treeWhen((tree) => memberTask(tree, QUILL)?.state === "active" && memberTask(tree, ROOK) !== undefined));

    await release("quill");
    const done = await run(settledTree((tree) => tree.tasks[0]?.state === "completed"));
    expect(done.tasks[0]?.result?.summary).toBe("The app is built");
    const rook = taskOf(done, ROOK);
    const quill = taskOf(done, QUILL);
    expect(rook.state).toBe("completed");
    // One turn, started from what Quill returned; nobody handed Rook anything.
    expect(attemptsOf(done, rook)).toEqual(["completed"]);
    const [first, ...more] = promptsTo(requests, rook);
    expect(more).toEqual([]);
    expect(first?.prompt).toContain(`Task ${quill.id} (Write the backend) returned: Stores amounts as integer cents`);
    expect(first?.prompt).toContain("def total(cents): return sum(cents)");
    expect(done.handOffs).toEqual([]);
    // You sent one message; everything after it was Hobbots carrying the work on.
    const all = await run(messagesWhen((each) => continuations(each).length >= 1));
    expect(all.filter((m) => m.role === "user")).toHaveLength(1);
    await run(nothingOpen);
  }, 30_000);

  // covers OR-002, OR-003, EX-004
  it("[TC-OR-208] a hub that stops between Quill's completion and Rook's start loses nothing: Rook starts once after the restart, with Quill's result once", async () => {
    const database = await sharedDatabase();
    const first = await startHub(database);
    await first.run(send(["Build the app", backend, frontend]));
    await first.run(
      treeWhen((tree) => memberTask(tree, QUILL)?.state === "active" && memberTask(tree, ROOK) !== undefined),
    );
    // Rook rests, so his Task cannot start when Quill's completes.
    await first.run(HobLifecycle.use((lifecycle) => lifecycle.pause(ROOK)));
    await first.release("quill");
    const between = await first.run(settledTree((tree) => memberTask(tree, QUILL)?.state === "completed"));
    // Aldric's continuation on Quill's result has ended, so nothing of his is cut off.
    await first.run(messagesWhen((each) => continuations(each).length === 1));
    expect(taskOf(between, ROOK).state).toBe("queued");
    expect(attemptsOf(between, taskOf(between, ROOK))).toEqual([]);

    first.stop();

    const second = await startHub(database, [wrapUp]);
    await second.run(HobLifecycle.use((lifecycle) => lifecycle.wake(ROOK)));
    const done = await second.run(settledTree((tree) => tree.tasks[0]?.state === "completed"));
    const rook = taskOf(done, ROOK);
    expect(attemptsOf(done, rook)).toEqual(["completed"]);
    const sent = [...first.requests, ...second.requests];
    const rookPrompts = promptsTo(sent, rook);
    expect(rookPrompts).toHaveLength(1);
    expect(rookPrompts[0]?.prompt.split("Stores amounts as integer cents")).toHaveLength(2);
    expect(done.tasks.map((task) => task.state)).toEqual(["completed", "completed", "completed"]);
    await second.run(nothingOpen);
  }, 40_000);
});

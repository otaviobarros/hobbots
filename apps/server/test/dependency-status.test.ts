import { HobLifecycle } from "@hobbots/agents";
import { describe, expect, it } from "vitest";
import {
  attemptsOf,
  hold,
  hub,
  memberTask,
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

// Issue #567: a member resumed in its session after a Task its work builds on completed is told,
// on that turn, where that Task stands now and what it returned. It no longer sees only the state
// its first prompt showed, so it can finish without asking its lead whether the work is done.

describe("a resumed member hears where its inputs stand", () => {
  // covers OR-003, OR-005
  it("[TC-OR-212] Rook, resumed after Quill's Task completed and its artifact was handed to him, gets Quill's result once and finishes without asking again", async () => {
    const { run, requests, release } = await startHub(await sharedDatabase(), [
      {
        on: "was answered by hob aldric",
        lines: [hub("complete_task", { key: "frontend-done", summary: "Frontend renders integer cents" })],
      },
    ]);
    await run(
      send([
        "Build the app",
        hub("delegate_task", {
          key: "backend",
          hob: "Quill",
          brief: [
            "Write the backend",
            hold("quill"),
            hub("complete_task", {
              key: "backend-done",
              summary: "Stores amounts as integer cents",
              artifacts: [{ kind: "file", label: "core.py", value: "/project/core.py" }],
            }),
          ].join("\n"),
        }),
        hub("delegate_task", {
          key: "frontend",
          hob: "Rook",
          brief: ["Write the frontend", hub("ask", { key: "units", question: "Are amounts floats or cents?" })].join(
            "\n",
          ),
        }),
      ]),
    );
    // Rook asks while Quill still works; his first prompt knows nothing of Quill's result.
    await run(treeWhen((tree) => tree.questions.length === 1 && memberTask(tree, ROOK)?.state === "waiting"));
    await release("quill");
    const built = await run(treeWhen((tree) => memberTask(tree, QUILL)?.state === "completed"));
    const quill = taskOf(built, QUILL);

    // Aldric answers and hands Quill's core.py to Rook, who rests meanwhile so that one turn of his
    // session goes on with both.
    await run(HobLifecycle.use((lifecycle) => lifecycle.pause(ROOK)));
    await run(
      send([
        "Answer Rook and hand him the backend",
        hub("answer", { key: "reply", question_id: "$units.question_id", answer: "Cents, see core.py" }),
        hub("hand_off", { key: "hand", artifact_id: "$backend-done.artifacts.0", to_task_id: "$frontend.task_id" }),
      ]),
    );
    await run(treeWhen((tree) => tree.handOffs.length === 1 && tree.questions[0]?.state === "answered"));
    await run(HobLifecycle.use((lifecycle) => lifecycle.wake(ROOK)));
    const done = await run(settledTree((tree) => memberTask(tree, ROOK)?.state === "completed"));
    const rook = taskOf(done, ROOK);
    const [firstPrompt, resumed, ...more] = promptsTo(requests, rook);
    expect(more).toEqual([]);
    expect(firstPrompt?.prompt).not.toContain("Stores amounts as integer cents");
    expect(resumed?.sessionId).not.toBeNull();
    expect(resumed?.prompt).toContain(
      `  - Task ${quill.id} (Write the backend), completed: Stores amounts as integer cents`,
    );
    expect(resumed?.prompt.split("Stores amounts as integer cents")).toHaveLength(2);
    // He finished from that turn: one question, two turns of one Attempt (#668), and his own result.
    expect(done.questions.filter((each) => each.askerId === ROOK)).toHaveLength(1);
    expect(attemptsOf(done, rook)).toEqual(["completed"]);
    expect(rook.result?.summary).toBe("Frontend renders integer cents");
  }, 30_000);
});

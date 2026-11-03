import { HobLifecycle } from "@hobbots/agents";
import { describe, expect, it } from "vitest";
import {
  attemptsOf,
  hold,
  hub,
  memberTask,
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
} from "./party-hub.ts";

/** The rule's heart, as packages/orchestration/src/briefs.ts states it to leads and members alike. */
const RULE = "anything else one member made reaches another only when the lead calls hand_off";

// Issue #566: a lead told its member that results "will reach you as context" when they would not.
// Now each turn on a Task that leads a Quest states how results move, in the words the member is
// told: a lead that follows it hands a running member what it asks for, and the Quest finishes.

describe("a lead that follows the hand-off rule", () => {
  // covers OR-003, OR-005
  it("[TC-OR-218] Aldric, told the rule on Quill's result, hands core.py to Rook, who asked for it while running, and Rook completes from it", async () => {
    const { run, requests, release } = await startHub(await sharedDatabase(), [
      {
        on: "(Write the backend) finished",
        lines: [
          hub("hand_off", { key: "hand", artifact_id: "$backend-done.artifacts.0", to_task_id: "$frontend.task_id" }),
          hub("answer", { key: "reply", question_id: "$need.question_id", answer: "Handed core.py to your Task" }),
        ],
      },
      {
        on: "was answered by hob aldric",
        lines: [hub("complete_task", { key: "frontend-done", summary: "Frontend reads core.py" })],
      },
      { on: "(Write the frontend) finished", lines: [hub("complete_task", { key: "wrap", summary: "The app is built" })] },
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
          brief: ["Write the frontend", hub("ask", { key: "need", question: "Will you hand me Quill's core.py?" })].join(
            "\n",
          ),
        }),
      ]),
    );
    // Rook runs alongside Quill and asks for what Quill makes; he rests until Aldric has answered.
    await run(treeWhen((tree) => tree.questions.length === 1 && memberTask(tree, ROOK)?.state === "waiting"));
    await run(HobLifecycle.use((lifecycle) => lifecycle.pause(ROOK)));
    await release("quill");
    await run(treeWhen((tree) => tree.handOffs.length === 1 && tree.questions[0]?.state === "answered"));
    await run(HobLifecycle.use((lifecycle) => lifecycle.wake(ROOK)));
    const done = await run(settledTree((tree) => tree.tasks[0]?.state === "completed"));

    // The turn Aldric handed off from was told the rule, in the member's words.
    const leadTurn = requests.find((each) => each.prompt.includes("(Write the backend) finished"));
    expect(`${leadTurn?.briefing ?? ""}\n${leadTurn?.prompt ?? ""}`).toContain(RULE);
    const rook = taskOf(done, ROOK);
    const [first, resumed] = promptsTo(requests, rook);
    expect(first?.prompt).toContain(RULE);
    expect(resumed?.prompt).toContain("/project/core.py");
    expect(done.handOffs).toHaveLength(1);
    expect(attemptsOf(done, rook)).toEqual(["completed", "completed"]);
    expect(rook.result?.summary).toBe("Frontend reads core.py");
    expect(taskOf(done, QUILL).state).toBe("completed");
    expect(done.tasks[0]?.result?.summary).toBe("The app is built");
    await run(nothingOpen);
  }, 30_000);
});

import type { AttemptId, TaskTree } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { endedActivity, hub, say, setUp, treeWhen } from "./workbench-hub.ts";

// Issue #892: a turn outside any chat, such as a planned step's, keeps its steps on its Attempt as a
// chat reply keeps its own, so its Task shows what it did.

const write = (path: string, text: string) => `fake:write ${path} ${JSON.stringify(text)}`;

const stepsDone = (tree: TaskTree) =>
  tree.tasks.some((task) => task.parentId !== null) &&
  tree.tasks.filter((task) => task.parentId !== null).every((task) => task.state === "completed");

describe("a step's own steps", () => {
  it("keeps the tool calls of a planned step's turn on its Attempt, ended", async () => {
    const { run: inHub } = setUp({ "README.md": "# Site\n" });
    await inHub(
      say(
        [
          "Write the guide",
          hub("plan_steps", { key: "plan", steps: [{ brief: write("GUIDE.md", "# Guide\n") }] }),
        ].join("\n"),
      ),
    );
    const tree = await inHub(treeWhen(stepsDone));
    const step = tree.tasks.find((task) => task.parentId !== null);
    const attempt = tree.attempts.find((each) => each.taskId === step?.id);
    const activity = await inHub(endedActivity(attempt?.id as AttemptId));
    const tools = activity.steps.filter((each) => each.kind === "tool");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((each) => each.call?.operation === "edit-files")).toBe(true);
    expect(activity.steps.every((each) => each.state !== "running" && each.state !== "awaiting")).toBe(true);
  }, 30_000);

  it("keeps none on the lead's own Attempt, whose steps stay on its chat reply", async () => {
    const { run: inHub } = setUp({ "README.md": "# Site\n" });
    await inHub(
      say(
        ["Write the guide", hub("start_quest", { key: "quest", goal: "Write it" }), write("GUIDE.md", "# G\n")].join(
          "\n",
        ),
      ),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const activity = await inHub(endedActivity(tree.attempts[0]?.id as AttemptId));
    expect(activity.steps).toEqual([]);
  }, 30_000);
});

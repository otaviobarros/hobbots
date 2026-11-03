import { describe, expect, it } from "vitest";
import { endedActivity, fakeRun, hub, say, setUp, treeWhen } from "./workbench-hub.ts";

// Issue #591: every command keeps its exit code, and one that exits non-zero is recorded as failed,
// on SQLite or PostgreSQL (TestDatabase).

describe("a command's exit code in a Task's activity", () => {
  // covers UX-002, UX-006
  it("[TC-RT-104] keeps each command's exit code, and records one that exits non-zero as failed", async () => {
    const { run: inHub } = setUp({ "notes.md": "# Notes\n" });
    await inHub(
      say(
        [
          "Run the checks",
          fakeRun({ command: "true" }),
          fakeRun({ command: "pytest", output: "ImportError: no module named notes\n", exitCode: 1 }),
          fakeRun({ command: "make lint", exitCode: 2 }),
          hub("start_quest", { key: "quest", goal: "Run the checks" }),
        ].join("\n"),
      ),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const attempt = tree.attempts[0];
    if (attempt === undefined) throw new Error("no Attempt");
    const activity = await inHub(endedActivity(attempt.id));

    expect(activity.commands.map(({ command, state, exitCode }) => ({ command, state, exitCode }))).toEqual([
      { command: "true", state: "succeeded", exitCode: 0 },
      { command: "pytest", state: "failed", exitCode: 1 },
      { command: "make lint", state: "failed", exitCode: 2 },
    ]);
    // What the command printed is its output, without the runtime's exit code line.
    expect(activity.commands[1]?.output?.head).toBe("ImportError: no module named notes\n");
  }, 30_000);
});

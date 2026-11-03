import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptId, TaskTree } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { endedActivity, fakeRun, HOLD, hub, say, setUp, treeWhen } from "./workbench-hub.ts";

// Issue #595: a turn records only the changes it made, from its own tool calls, even while another
// turn works in the same folder, on SQLite or PostgreSQL (TestDatabase).

/** A plan of steps that each wait at their start, so they run together once released. */
const plan = (steps: ReadonlyArray<{ readonly name: string; readonly work: string }>) =>
  hub("plan_steps", {
    key: "plan",
    steps: steps.map(({ name, work }) => ({ brief: [name, HOLD, work].join("\n") })),
  });

const stepsDone = (tree: TaskTree) =>
  tree.tasks.filter((task) => task.parentId !== null).every((task) => task.state === "completed");

/** Each step's Attempt id by its brief's first line. */
const stepAttempts = (tree: TaskTree) =>
  new Map(
    tree.tasks
      .filter((task) => task.parentId !== null)
      .map((task) => [
        task.brief.split("\n")[0] ?? "",
        tree.attempts.find((attempt) => attempt.taskId === task.id)?.id as AttemptId,
      ]),
  );

const write = (path: string, text: string) => `fake:write ${path} ${JSON.stringify(text)}`;

describe("a turn's own changes", () => {
  // covers UX-002, ADR 023
  it("[TC-RT-106] two turns writing different files in one folder at the same time each record only their own", async () => {
    const { run: inHub, release } = setUp({ "README.md": "# Site\n" });
    await inHub(
      say(
        [
          "Write the docs",
          plan([
            { name: "guide", work: write("docs/GUIDE.md", "# Guide\n") },
            { name: "review", work: write("docs/REVIEW.md", "# Review\n") },
          ]),
        ].join("\n"),
      ),
    );
    await release();
    const tree = await inHub(treeWhen(stepsDone));
    const attempts = stepAttempts(tree);
    const changesOf = async (step: string) => {
      const activity = await inHub(endedActivity(attempts.get(step) as AttemptId));
      return activity.changes.map(({ path, kind, sharedWith }) => ({ path, kind, sharedWith }));
    };

    expect(await changesOf("guide")).toEqual([{ path: "docs/GUIDE.md", kind: "added", sharedWith: [] }]);
    expect(await changesOf("review")).toEqual([{ path: "docs/REVIEW.md", kind: "added", sharedWith: [] }]);
  }, 30_000);

  // covers UX-002, ADR 023
  it("[TC-RT-107] a file a command makes is the turn's that ran it, not another's working beside it, nor the hub's", async () => {
    const { run: inHub, release, holding, folder } = setUp({ "notes.txt": "Notes\n", "scratch/tmp.txt": "tmp\n" });
    await inHub(
      say(
        [
          "Tidy the project",
          plan([
            {
              name: "build",
              work: fakeRun({
                command: "make tidy",
                writes: { Makefile: "all:\n", "docs/NOTES.md": "Notes\n", "notes.txt": null, "scratch/tmp.txt": null },
              }),
            },
            { name: "review", work: write("REVIEW.md", "# Review\n") },
          ]),
        ].join("\n"),
      ),
    );
    // Someone else changes the folder while the steps wait: no step made it.
    await holding(2);
    writeFileSync(join(folder, "README.md"), "# Edited by hand\n");
    await release();
    const tree = await inHub(treeWhen(stepsDone));
    const attempts = stepAttempts(tree);
    const build = await inHub(endedActivity(attempts.get("build") as AttemptId));
    const review = await inHub(endedActivity(attempts.get("review") as AttemptId));

    expect(build.changes.map(({ path, kind, movedFrom }) => ({ path, kind, movedFrom }))).toEqual([
      { path: "Makefile", kind: "added", movedFrom: null },
      { path: "docs/NOTES.md", kind: "moved", movedFrom: "notes.txt" },
      { path: "scratch/tmp.txt", kind: "deleted", movedFrom: null },
    ]);
    expect(review.changes.map(({ path, kind }) => ({ path, kind }))).toEqual([{ path: "REVIEW.md", kind: "added" }]);
  }, 30_000);

  // covers UX-002, ADR 023
  it("[TC-RT-108] leaves build caches and system files out of a turn's changes", async () => {
    const { run: inHub } = setUp({ "app.py": "print('hi')\n" });
    await inHub(
      say(
        [
          "Run the app",
          fakeRun({
            command: "python -m app",
            writes: {
              "__pycache__/app.cpython-313.pyc": "bytecode",
              ".pytest_cache/v/cache/lastfailed": "{}",
              ".DS_Store": "finder",
              "out.txt": "hi\n",
            },
          }),
          hub("start_quest", { key: "quest", goal: "Run the app" }),
        ].join("\n"),
      ),
    );
    const tree = await inHub(treeWhen((each) => each.attempts.length > 0));
    const activity = await inHub(endedActivity(tree.attempts[0]?.id as AttemptId));

    expect(activity.changes.map(({ path }) => path)).toEqual(["out.txt"]);
  }, 30_000);
});

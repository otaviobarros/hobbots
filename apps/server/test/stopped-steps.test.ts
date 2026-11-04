import type { Task, TaskTree } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ALDRIC,
  hold,
  hub,
  promptsTo,
  type Reaction,
  send,
  settledTree,
  sharedDatabase,
  startHub,
  treeWhen,
} from "./dependency-hub.ts";

// Issue #667: a step that reports a finding or blocker and ends with no result of its own is
// blocked, not completed with its reply, so the step after it waits for its owner. The owner's
// next turn hears of it with the finding, and either completes the step to go on or cancels and
// plans again.

const FINDING = "The README and SPEC are already there from commit b450b68";

/** Step 1 finds its work already done and stops on a finding; step 2 comes after it. */
const plan = hub("plan_steps", {
  key: "plan",
  steps: [
    {
      brief: [
        "Write the README and SPEC",
        hub("report_checkpoint", { key: "found", kind: "finding", summary: FINDING }),
      ].join("\n"),
    },
    {
      brief: ["Write the notes", hub("complete_task", { key: "notes", summary: "Notes written" })].join("\n"),
      after: [1],
    },
  ],
});

/** Aldric's steps, in the order planned. */
const stepsOf = (tree: TaskTree): ReadonlyArray<Task> =>
  tree.tasks.filter((task) => task.ownerId === ALDRIC && task.parentId !== null);

const stepAt = (tree: TaskTree, index: number): Task => {
  const found = stepsOf(tree)[index];
  if (found === undefined) throw new Error(`no step ${index + 1}`);
  return found;
};

/** Aldric's turn that hears step 1 was blocked: the step's state, with the finding in its briefing. */
const BLOCKED_ARRIVAL = "ended as blocked";

/** Runs the plan until step 1 is blocked. */
const untilBlocked = async (reactions: ReadonlyArray<Reaction>) => {
  const database = await sharedDatabase();
  const started = await startHub(database, reactions);
  await started.run(send(["Write the docs", plan]));
  // Step 1's own turn has ended; Aldric's, which hears of it, may already be running.
  const blocked = await started.run(
    treeWhen((tree) => {
      const first = stepsOf(tree)[0];
      return (
        first?.state === "blocked" &&
        !tree.attempts.some(
          (each) => each.taskId === first.id && (each.state === "starting" || each.state === "running"),
        )
      );
    }),
  );
  return { ...started, database, blocked };
};

describe("a step that stops on a finding holds the steps after it", () => {
  // covers OR-002, OR-004
  it("[TC-OR-400] step 1 is blocked, step 2 waits, and Aldric completing step 1 releases step 2", async () => {
    const goOn: Reaction = {
      on: BLOCKED_ARRIVAL,
      lines: [
        hub("complete_task", {
          key: "go-on",
          task_id: "$plan.steps.0.task_id",
          summary: "Keep the README and SPEC as they are",
        }),
      ],
    };
    const { run, requests, blocked } = await untilBlocked([goOn]);
    const first = stepAt(blocked, 0);
    // Its reply is no result: the step is blocked with the finding as its latest report.
    expect(first.result).toBeNull();
    expect(blocked.checkpoints.filter((each) => each.taskId === first.id).map((each) => each.kind)).toContain(
      "finding",
    );

    const done = await run(settledTree((tree) => stepsOf(tree)[1]?.state === "completed"));
    // Aldric's turn carried the finding, and was told how to go on or plan again.
    const heard = requests.find((request) => request.prompt.includes(BLOCKED_ARRIVAL));
    expect(heard?.briefing).toContain(`blocked: Write the README and SPEC. Latest: finding, ${FINDING}`);
    expect(heard?.briefing).toContain("call complete_task on that step");
    expect(stepAt(done, 0).state).toBe("completed");
    expect(stepAt(done, 0).result?.summary).toBe("Keep the README and SPEC as they are");
    // Step 2 started only after that, from Aldric's decision.
    const second = stepAt(done, 1);
    expect(promptsTo(requests, second).map((request) => request.prompt)).toEqual([
      expect.stringContaining("Step 1 returned: Keep the README and SPEC as they are"),
    ]);
    expect(second.result?.summary).toBe("Notes written");
  }, 30_000);

  // covers OR-002, OR-006
  it("[TC-OR-401] step 2 never runs when Aldric cancels both steps and plans again", async () => {
    const replan: Reaction = {
      on: BLOCKED_ARRIVAL,
      lines: [
        // Aldric plans again only once the test has seen step 1 blocked and step 2 queued.
        hold("replan"),
        hub("cancel_task", { key: "drop-1", task_id: "$plan.steps.0.task_id" }),
        hub("cancel_task", { key: "drop-2", task_id: "$plan.steps.1.task_id" }),
        hub("plan_steps", {
          key: "replan",
          steps: [
            { brief: ["Start clean", hub("complete_task", { key: "clean", summary: "Started clean" })].join("\n") },
          ],
        }),
      ],
    };
    const { run, requests, blocked, release } = await untilBlocked([replan]);
    const second = stepAt(blocked, 1);
    expect(second.state).toBe("queued");
    await release("replan");

    const done = await run(settledTree((tree) => stepsOf(tree)[2]?.state === "completed"));
    expect(stepsOf(done).map((step) => step.state)).toEqual(["cancelled", "cancelled", "completed"]);
    expect(promptsTo(requests, second)).toEqual([]);
  }, 30_000);

  // covers OR-002, EX-004
  it("[TC-OR-403] a step held for Aldric stays held, with step 2 queued, after Hobbots restarts", async () => {
    const { database, stop } = await untilBlocked([]);
    stop();
    const again = await startHub(database);
    // Startup recovery ends the steps left open with no live Attempt; a held one is not among them.
    const after = await again.run(settledTree((tree) => stepsOf(tree)[1]?.state === "queued"));
    expect(stepsOf(after).map((step) => step.state)).toEqual(["blocked", "queued"]);
  }, 30_000);
});

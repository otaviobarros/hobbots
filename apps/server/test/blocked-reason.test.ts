import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { hub, memberTask, ROOK, retry, send, sharedDatabase, startHub, taskOf, treeWhen } from "./dependency-hub.ts";

// Issue #571: a member whose Task was only waiting was shown Blocked, its lead guessed "most likely
// an approval" and delegated the same work again. A member that waits on something reads waiting;
// one that is blocked says why, in words its lead reads; and a second Task for the same hob under
// the same Task warns the lead.

describe("blocked says why, and waiting is not blocked", () => {
  // covers OR-004, OR-005
  it("[TC-OR-220] Rook, with an unreported milestone and an open question, ends his turn waiting, not blocked", async () => {
    const { run } = await startHub(await sharedDatabase());
    await run(
      send([
        "Build the app",
        hub("delegate_task", {
          key: "frontend",
          hob: "Rook",
          brief: ["Write the frontend", hub("ask", { key: "units", question: "Are amounts floats or cents?" })].join(
            "\n",
          ),
          milestones: ["Page live"],
        }),
      ]),
    );
    const tree = await run(
      treeWhen((each) => each.questions.length === 1 && memberTask(each, ROOK)?.state === "waiting"),
    );
    const rook = taskOf(tree, ROOK);
    expect(tree.checkpoints.filter((each) => each.taskId === rook.id && each.kind === "blocker")).toEqual([]);
  }, 30_000);

  // covers OR-004, OR-005
  it("[TC-OR-221] Rook, with only an unreported milestone, is blocked with a reason that reaches Aldric's next turn", async () => {
    const { run, requests } = await startHub(await sharedDatabase());
    await run(
      send([
        "Build the app",
        hub("delegate_task", { key: "frontend", hob: "Rook", brief: "Write the frontend", milestones: ["Page live"] }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "blocked"));
    const rook = taskOf(tree, ROOK);
    const [blocker] = tree.checkpoints.filter((each) => each.taskId === rook.id && each.kind === "blocker");
    expect(blocker?.summary).toContain('only its own milestones are unreported: "Page live"');
    expect(blocker?.summary).toContain("It waits on no question, approval or other Task");
    expect(blocker?.summary).toContain("delegating the same work again leaves this Task open");

    // Aldric's next turn is told Rook's Task is blocked, and why.
    await run(send(["How is the frontend going?"]));
    const lead = await run(
      retry(
        Effect.suspend(() => {
          const found = requests.find((each) => each.prompt.includes("How is the frontend going?"));
          return found === undefined ? Effect.fail("not yet") : Effect.succeed(found);
        }),
      ),
    );
    const briefing = `${lead.briefing ?? ""}\n${lead.prompt}`;
    expect(briefing).toContain(`Task ${rook.id}, blocked: Write the frontend.`);
    expect(briefing).toContain("Latest: blocker, Its member ended a turn without completing it");
  }, 30_000);

  // covers OR-005
  it("[TC-OR-222] a second Task for Rook under the same Task warns Aldric of the open one", async () => {
    const { run, answers } = await startHub(await sharedDatabase());
    await run(
      send([
        "Build the app",
        hub("delegate_task", { key: "first", hob: "Rook", brief: "Write the frontend", milestones: ["Page live"] }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "blocked"));
    const first = taskOf(tree, ROOK);
    expect(answers.get("first")).not.toContain("already has open work");

    await run(send(["Try again", hub("delegate_task", { key: "second", hob: "Rook", brief: "Write the frontend" })]));
    await run(treeWhen((each) => each.tasks.filter((task) => task.ownerId === ROOK).length === 2));
    expect(answers.get("second")).toContain(
      `Rook already has open work under this Task: ${first.id} (blocked): Write the frontend.`,
    );
    expect(answers.get("second")).toContain("cancel one of them");
  }, 30_000);
});

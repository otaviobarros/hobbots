import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, messagesWhen, ownedBy, PIP, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #576: Pip started a nested Quest and never brought anyone into it, and nothing flagged it
// for fifteen minutes. A member's turn that ends leaving a Quest it leads with nobody in it and
// nothing to wait on now reports one finding, which reaches its lead.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const EMPTY = "Started a Quest but has not brought anyone in";

describe("an empty nested Quest", () => {
  // covers OR-004, OR-005, IN-004
  it("[TC-OR-246] a member whose turn leaves its own Quest empty reports one finding, and its lead hears of it", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests } = party;
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review the project",
            hub("start_quest", { key: "nested", goal: "Review and commit the project" }),
            hub("ask", { key: "who", question: "Should Nettle make the commit?" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
        // Frodo's next turns answer Pip; Pip's next turn ends with the Quest still empty.
        `fake:then ${hub("answer", { key: "yes", question_id: "$who.question_id", answer: "Yes, bring Nettle in." })}`,
      ]),
    );

    const flagged = await run(
      treeWhen((tree) => tree.checkpoints.some((each) => each.kind === "finding" && each.summary.startsWith(EMPTY))),
    );
    const pip = ownedBy(flagged, PIP);
    const finding = flagged.checkpoints.find((each) => each.kind === "finding" && each.taskId === pip?.id);
    expect(finding?.summary).toContain(`Quest ${flagged.quests.find((each) => each.taskId === pip?.id)?.id}`);
    expect(finding?.summary).toContain("Review and commit the project");

    // Frodo hears of it in a turn of his own, about Pip's Task.
    await run(
      messagesWhen(() => requests.some((each) => each.prompt.includes(EMPTY) && each.prompt.includes(String(pip?.id)))),
    );
    const toFrodo = requests.filter((each) => each.prompt.includes(EMPTY));
    expect(toFrodo.length).toBeGreaterThan(0);
    expect(toFrodo.every((each) => !each.prompt.includes(`You work on Task ${pip?.id} `))).toBe(true);

    // Pip's later turn, once answered, leaves the Quest empty again: still one finding. It goes on
    // in his Task's one Attempt (#668), so his later prompts are counted instead.
    const later = `You work on Task ${pip?.id} for Frodo.`;
    const after = await run(
      treeWhen(
        (tree) =>
          tree.questions[0]?.state === "answered" &&
          requests.some((each) => each.sessionId !== null && each.prompt.includes(later)) &&
          !tree.attempts.some((each) => each.state === "starting" || each.state === "running"),
      ),
    );
    expect(after.checkpoints.filter((each) => each.summary.startsWith(EMPTY))).toHaveLength(1);
    expect(after.tasks[0]?.ownerId).toBe(FRODO);
  }, 30_000);
});

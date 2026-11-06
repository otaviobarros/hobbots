import { IDLE_QUEST } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { continuations, hub, messagesWhen, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #1081: Frodo started a Quest, wrote its plan and ended the turn without delegating. The
// Quest sat idle with nothing to wake it, and nothing told you. Now such a turn wakes its lead once
// with what is missing, and a lead that still leaves it so has its Task blocked, so you see it.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const STALLED = "The Quest stalled";

describe("a Quest its lead leaves idle", () => {
  // covers OR-004, IN-004, EX-002
  it("[TC-OR-645] wakes its lead once, then blocks the Task you asked for, and a later delegation unblocks it", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests } = party;
    await run(
      send([
        "Build the page",
        hub("start_quest", { key: "quest", goal: "Build the page" }),
        "Quill will build the backend, Rook will render the page after Quill.",
      ]),
    );

    // The turn ended with nobody delegated to: the hub wakes Frodo with what is missing.
    await run(
      messagesWhen((all) => continuations(all).length > 0 && requests.some((each) => each.prompt.includes(IDLE_QUEST))),
    );
    const woken = requests.filter((each) => each.prompt.includes(IDLE_QUEST));
    expect(woken).toHaveLength(1);
    expect(woken[0]?.prompt).toContain("delegate_task");

    // That turn again left nothing moving the Quest: the Task is blocked, with a reason you read.
    const stalled = await run(treeWhen((tree) => tree.tasks[0]?.state === "blocked"));
    expect(stalled.checkpoints.filter((each) => each.summary === IDLE_QUEST)).toHaveLength(1);
    expect(stalled.checkpoints.some((each) => each.kind === "blocker" && each.summary.startsWith(STALLED))).toBe(true);
    expect(stalled.quests[0]?.state).toBe("active");
    // Blocking it wakes nobody: no turn after the one that was woken.
    expect(requests.filter((each) => each.prompt.includes(IDLE_QUEST))).toHaveLength(1);

    // You tell Frodo to go on, and he delegates: the Quest moves again, so the Task is not blocked.
    await run(
      send([
        "Go on and bring Quill in",
        hub("delegate_task", { key: "backend", hob: "Quill", brief: "Build the backend" }),
      ]),
    );
    const moving = await run(
      treeWhen((tree) => tree.tasks.some((each) => each.parentId !== null) && tree.tasks[0]?.state !== "blocked"),
    );
    expect(moving.tasks[0]?.state).not.toBe("blocked");
  }, 30_000);
});

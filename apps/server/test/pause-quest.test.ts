import { HobbotsRepository, TaskControls } from "@hobbots/agents";
import { mainLine, noteReceipt, OWNER_ACTOR, type RuntimeKind, type TaskTree } from "@hobbots/domain";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  FRODO,
  hub,
  isLive,
  messagesWhen,
  ownedBy,
  PIP,
  partyHub,
  QUILL,
  ROOK,
  send,
  threadId,
  treeWhen,
} from "./party-hub.ts";

// Issue #1446: you pause a Quest, or pause it now, and resume it; a lead retries and reassigns its
// members' Tasks itself; and your @mention of a member reaches that member without waking the lead.
// The hub decides each, so it holds for every runtime.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

/** Frodo hands Pip the page, whose turn holds on `hold` until the test opens it, and waits for him. */
const delegated = send([
  "Write the launch page",
  hub("delegate_task", {
    key: "page",
    hob: "Pip",
    brief: [
      "Write the launch page",
      hub("report_checkpoint", { key: "hold", kind: "progress", summary: "Writing" }),
    ].join("\n"),
  }),
  hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
]);

/** Pip's turn runs. */
const pipRuns = (tree: TaskTree) =>
  tree.attempts.some((each) => each.taskId === ownedBy(tree, PIP)?.id && isLive(each.state));

const never = () => new Promise<void>(() => {});

describe.each(RUNTIMES)("pausing a Quest, on %s", (runtime) => {
  // covers OR-006, EX-004
  it("[TC-OR-1446-21] Pause now stops the member's turn, starts nothing while paused, and Resume tells it what changed", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, gates, requests, settledRound } = party;
    gates.set("hold", never);
    await run(delegated);
    const running = await run(treeWhen(pipRuns));
    const questId = running.quests[0]?.id;
    if (questId === undefined) throw new Error("no Quest");

    await run(TaskControls.use((controls) => controls.pauseQuest(questId, true)));
    const paused = await run(
      treeWhen((tree) => ownedBy(tree, PIP)?.state === "paused" && !tree.attempts.some((each) => isLive(each.state))),
    );
    expect(paused.quests[0]?.state).toBe("paused");
    expect(paused.tasks[0]?.state).toBe("paused");
    expect(ownedBy(paused, PIP)?.pause).toMatchObject({ now: true, by: OWNER_ACTOR });
    const sent = requests.length;
    // A whole round of the runner after the pause starts no turn on the paused work.
    await run(settledRound);
    expect(requests).toHaveLength(sent);

    gates.delete("hold");
    await run(TaskControls.use((controls) => controls.resumeQuest(questId)));
    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed"));
    expect(done.quests[0]?.state).not.toBe("paused");
    const told = requests.slice(sent).filter((each) => each.prompt.includes("The user paused this work"));
    // Each hob hears once; only Pip's turn was stopped, so only Pip is told to check what it finished.
    expect(told.filter((each) => each.prompt.includes("Your turn was stopped when it was paused"))).toHaveLength(1);
  }, 30_000);

  // covers IN-004, STD-ARCH-019
  it("[TC-OR-1446-22] an @mention reaches the member's running turn as your note, and never wakes the lead", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, gates, requests } = party;
    gates.set("hold", never);
    await run(delegated);
    await run(treeWhen(pipRuns));
    const leadTurns = () => requests.filter((each) => each.prompt.includes("Write the launch page") === false).length;
    const before = leadTurns();

    const { userMessage, assistantMessage } = await run(send(["@Pip use the blue theme"]));
    expect(assistantMessage).toBeNull();
    expect(userMessage.status).toBe("complete");
    const tree = await run(treeWhen((each) => each.notes.some((note) => note.messageId === userMessage.id)));
    const note = tree.notes.find((each) => each.messageId === userMessage.id);
    expect(note).toMatchObject({ recipientId: PIP, senderId: null, author: OWNER_ACTOR, delivery: "steer" });
    if (note === undefined) throw new Error("no note");
    expect(noteReceipt(note, tree)).toEqual({ _tag: "Held", reason: "turn-running" });
    // The member takes it from its note, so nothing is owed in the lead's chat (ADR 039, #1461).
    expect(await run(HobbotsRepository.use((repo) => repo.openTurnRequests(mainLine(threadId))))).toEqual([]);
    // Your next message to the lead is answered after anything your mention could have woken, so
    // once its reply is in, the lead has answered that message only (STD-TEST-009).
    const asked = await run(send(["How is it going?"]));
    const replies = await run(
      messagesWhen((all) => all.some((each) => each.promptId === asked.userMessage.id && each.status === "complete")),
    );
    expect(replies.filter((each) => each.promptId === userMessage.id)).toEqual([]);
    expect(leadTurns()).toBe(before + 1);
    // A mention of a hob that cannot hear the thread refuses the whole message, as any message's does
    // (ADR 039): it is not stored, and the member it also mentions gets no note.
    const refused = await run(Effect.flip(send(["@Pip @Rook use the red theme"])));
    expect(refused).toMatchObject({ _tag: "MentionRefused", hobs: [ROOK] });
    const messages = await run(HobbotsRepository.use((repo) => repo.listMessages(threadId)));
    expect(messages.map((each) => each.id)).toEqual(replies.map((each) => each.id));
    expect((await run(treeWhen(() => true))).notes.filter((each) => each.text.includes("red theme"))).toEqual([]);
  }, 30_000);
});

describe.each(RUNTIMES)("a lead's retry and reassign, on %s", (runtime) => {
  // covers OR-006, EX-001, STD-SEC-003
  it("[TC-OR-1446-23] are refused on a stale revision, while a turn runs or by the Task's state, and a reassign hands the Task over", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, gates, answers } = party;
    gates.set("hold", never);
    await run(
      send([
        "Write the launch page",
        hub("delegate_task", {
          key: "copy",
          hob: "Rook",
          brief: [
            "Write the copy",
            hub("report_checkpoint", { key: "hold", kind: "progress", summary: "Writing" }),
          ].join("\n"),
        }),
        hub("delegate_task", { key: "page", hob: "Pip", brief: "Lay out the page", depends_on: ["$copy.task_id"] }),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id", "$page.task_id"] }),
      ]),
    );
    const before = await run(
      treeWhen((tree) => tree.attempts.some((each) => each.taskId === ownedBy(tree, ROOK)?.id && isLive(each.state))),
    );
    const rook = ownedBy(before, ROOK);
    const pip = ownedBy(before, PIP);
    if (rook === undefined || pip === undefined) throw new Error("no members");
    const reason = "Quill knows the layout";
    await run(
      send([
        "Give the layout to Quill",
        hub("reassign_task", {
          key: "stale",
          task_id: pip.id,
          hob: "Quill",
          reason,
          expected_revision: pip.revision - 1,
        }),
        hub("reassign_task", { key: "live", task_id: rook.id, hob: "Quill", reason, expected_revision: rook.revision }),
        hub("retry_task", { key: "retry", task_id: pip.id, reason, expected_revision: pip.revision }),
        hub("reassign_task", { key: "moved", task_id: pip.id, hob: "Quill", reason, expected_revision: pip.revision }),
      ]),
    );
    const after = await run(
      treeWhen((tree) => tree.tasks.some((each) => each.id === pip.id && each.ownerId === QUILL)),
    );

    expect(answers.get("stale")).toContain("Refused (task-changed)");
    expect(answers.get("live")).toContain("Refused (attempt-live)");
    expect(answers.get("retry")).toContain("Refused (task-state)");
    expect(answers.get("moved")).toContain("Gave Task");
    expect(after.delegations.find((each) => each.childTaskId === pip.id)?.memberId).toBe(QUILL);
    expect(after.notes.find((each) => each.taskId === pip.id)).toMatchObject({
      senderId: FRODO,
      recipientId: QUILL,
      text: `Reassigned to you: ${reason}`,
    });
  }, 30_000);
});

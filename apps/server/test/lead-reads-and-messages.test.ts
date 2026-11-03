import { NoteId, TaskId } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, NETTLE, ownedBy, PIP, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";
import { toolsHub } from "./tools-hub.ts";

// Issue #574: Frodo could not see Nettle's Task under Pip's nested Quest, and had no way to tell Pip
// that the obstacle was gone, so he cancelled a Quest that was one command from done. A lead now
// reads every Task under its own, at any depth, and messages a member's Task directly under it.

const TOP = TaskId.make("build");

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const party = [
  [FRODO, "Frodo"],
  [PIP, "Pip"],
  [NETTLE, "Nettle"],
  [QUILL, "Quill"],
] as const;

/** Frodo leads Pip, who leads Nettle in a nested Quest; Nettle asked Pip something and is stuck. */
const nested = async (hubTools: ReturnType<typeof toolsHub>) => {
  const { run, call, seed } = hubTools;
  await run(seed);
  const pip = TaskId.make(
    String(
      (await call(FRODO, TOP, "delegate_task", { key: "review", hob: "Pip", brief: "Review it" })).details.task_id,
    ),
  );
  const nettle = TaskId.make(
    String(
      (await call(PIP, pip, "delegate_task", { key: "commit", hob: "Nettle", brief: "Commit it" })).details.task_id,
    ),
  );
  const asked = await call(NETTLE, nettle, "ask", { key: "q", question: "git init was denied. What now?" });
  await call(NETTLE, nettle, "report_checkpoint", { key: "b", kind: "blocker", summary: "git init is denied" });
  return { pip, nettle, question: String(asked.details.question_id) };
};

describe("a lead reads its subtree and messages its members", () => {
  // covers OR-002, OR-006, PE-003
  it("[TC-OR-248] read_tasks returns every Task under the caller's, at any depth, and refuses Tasks outside it", async () => {
    const tools = toolsHub(party, TOP);
    dispose = tools.dispose;
    const { pip, nettle, question } = await nested(tools);
    const { call, refused, head } = tools;

    const before = await head();
    const read = await call(FRODO, TOP, "read_tasks", { key: "read" });
    expect(await head()).toEqual(before);
    const listed = read.details.tasks as ReadonlyArray<Record<string, unknown>>;
    expect(listed.map((each) => each.task_id)).toEqual([pip, nettle]);
    expect(listed[1]).toMatchObject({
      parent_id: pip,
      owner: NETTLE,
      brief: "Commit it",
      state: "queued",
      turn_running: false,
      open_questions: [{ question_id: question, question: "git init was denied. What now?", waits_for: PIP }],
      recent_checkpoints: [expect.objectContaining({ kind: "blocker", summary: "git init is denied" })],
    });

    // Pip reads his own subtree, from his Task or from Frodo's turn on a Task under Frodo's.
    const pips = await call(PIP, pip, "read_tasks", { key: "read" });
    expect((pips.details.tasks as ReadonlyArray<Record<string, unknown>>).map((each) => each.task_id)).toEqual([
      nettle,
    ]);
    expect(
      (pips.details.tasks as ReadonlyArray<{ open_questions: Array<{ waits_for: string }> }>)[0]?.open_questions[0]
        ?.waits_for,
    ).toBe("you");
    const fromAbove = await call(FRODO, TOP, "read_tasks", { key: "read-pip", task_id: pip });
    expect((fromAbove.details.tasks as ReadonlyArray<Record<string, unknown>>).map((each) => each.task_id)).toEqual([
      nettle,
    ]);

    // Nobody reads above or beside their own work.
    expect((await refused(PIP, pip, "read_tasks", { key: "up", task_id: TOP })).reason).toBe("outside-subtree");
    expect((await refused(NETTLE, nettle, "read_tasks", { key: "up", task_id: pip })).reason).toBe("outside-subtree");
  });

  // covers OR-002, IN-001, IN-004
  it("[TC-OR-249] message_task reaches a member directly under the lead once, however often it is retried, and never skips a level", async () => {
    const tools = toolsHub(party, TOP);
    dispose = tools.dispose;
    const { pip, nettle } = await nested(tools);
    const { call, refused, head, journaledSince, tree } = tools;

    const sent = await call(FRODO, TOP, "message_task", {
      key: "clear",
      task_id: pip,
      text: "git init is done; go on.",
    });
    expect(sent.details.recipient).toBe(PIP);
    const after = await head();
    expect(
      await call(FRODO, TOP, "message_task", { key: "clear", task_id: pip, text: "git init is done; go on." }),
    ).toEqual(sent);
    expect(await head()).toEqual(after);
    const notes = (await tree()).notes;
    expect(notes).toEqual([
      expect.objectContaining({
        id: NoteId.make(String(sent.details.message_id)),
        taskId: pip,
        senderId: FRODO,
        recipientId: PIP,
        text: "git init is done; go on.",
      }),
    ]);

    // A grandchild is reached through its own lead; a member never messages its lead this way.
    expect((await refused(FRODO, TOP, "message_task", { key: "skip", task_id: nettle, text: "Go on" })).reason).toBe(
      "not-lead",
    );
    expect((await refused(PIP, pip, "message_task", { key: "up", task_id: TOP, text: "Done?" })).reason).toBe(
      "outside-subtree",
    );
    expect(await journaledSince(after)).toEqual(["ToolCallRefused", "ToolCallRefused"]);
  });

  // covers OR-002, OR-006, IN-001, IN-004
  it("[TC-OR-250] once the obstacle clears, Frodo's message reaches Pip, Pip's reaches Nettle, and the nested Quest completes with no cancel", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run, requests, answers, reactions } = hubbed;
    // Each hob acts on the message that reaches it, and Frodo wraps up once Pip's result is in.
    reactions.push(
      {
        on: "Hob frodo sent you a message",
        lines: [
          hub("message_task", {
            key: "tell-nettle",
            task_id: "$commit.task_id",
            text: "git init is done. Commit now.",
          }),
        ],
      },
      {
        on: "One local commit",
        lines: [hub("complete_task", { key: "review-done", summary: "Reviewed and committed" })],
      },
      {
        on: "Hob pip sent you a message",
        lines: [
          hub("report_checkpoint", {
            key: "committed",
            kind: "milestone",
            summary: "Committed",
            milestone_id: "$commit.milestones.0",
          }),
          hub("complete_task", { key: "commit-done", summary: "One local commit" }),
        ],
      },
      { on: "Reviewed and committed", lines: [hub("complete_task", { key: "wrap", summary: "Built and committed" })] },
    );
    await run(
      send([
        "Build and commit the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review and commit",
            hub("delegate_task", {
              key: "commit",
              hob: "Nettle",
              milestones: ["Committed"],
              brief: [
                "Make the commit",
                hub("report_checkpoint", { key: "denied", kind: "blocker", summary: "git init is denied" }),
              ].join("\n"),
            }),
            hub("wait_for", { key: "pip-wait", tasks: ["$commit.task_id"] }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const stuck = await run(treeWhen((tree) => ownedBy(tree, NETTLE)?.state === "blocked"));
    const pip = ownedBy(stuck, PIP);
    const nettle = ownedBy(stuck, NETTLE);
    if (pip === undefined || nettle === undefined) throw new Error("no nested Quest");

    // You ran git init yourself and tell Frodo, who reads the work and tells Pip; Pip tells Nettle.
    await run(
      send([
        "I ran git init, so Nettle can commit now",
        hub("read_tasks", { key: "look" }),
        hub("message_task", { key: "tell-pip", task_id: pip.id, text: "git init is done. Tell Nettle to commit." }),
      ]),
    );
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(done.tasks.map((task) => task.state)).toEqual(["completed", "completed", "completed"]);
    expect(done.quests.map((quest) => quest.state)).not.toContain("cancelled");
    expect(answers.get("look")).toContain(String(nettle.id));
    expect(answers.get("look")).toContain("git init is denied");
    expect(answers.get("tell-nettle")).toContain("Sent to hob nettle");
    // Each message woke its member once.
    expect(requests.filter((each) => each.prompt.includes("Hob frodo sent you a message"))).toHaveLength(1);
    expect(requests.filter((each) => each.prompt.includes("Hob pip sent you a message"))).toHaveLength(1);
  }, 30_000);
});

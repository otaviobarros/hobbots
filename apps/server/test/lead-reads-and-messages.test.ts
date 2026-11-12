import { ApprovalService, RuntimeAdapter } from "@hobbots/agents";
import { NoteId, TaskId } from "@hobbots/domain";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  FRODO,
  firstPending,
  hub,
  messagesWhen,
  NETTLE,
  ownedBy,
  PIP,
  partyHub,
  QUILL,
  ROOK,
  send,
  treeWhen,
} from "./party-hub.ts";
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
      questions: [{ question_id: question, question: "git init was denied. What now?", state: "open", waits_for: PIP }],
      recent_checkpoints: [expect.objectContaining({ kind: "blocker", summary: "git init is denied" })],
    });

    // Pip reads his own subtree, from his Task or from Frodo's turn on a Task under Frodo's.
    const pips = await call(PIP, pip, "read_tasks", { key: "read" });
    expect((pips.details.tasks as ReadonlyArray<Record<string, unknown>>).map((each) => each.task_id)).toEqual([
      nettle,
    ]);
    expect(
      (pips.details.tasks as ReadonlyArray<{ questions: Array<{ waits_for: string }> }>)[0]?.questions[0]?.waits_for,
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
        lines: [hub("complete_task", { delivered: true, key: "review-done", summary: "Reviewed and committed" })],
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
          hub("complete_task", { delivered: true, key: "commit-done", summary: "One local commit" }),
        ],
      },
      {
        on: "(Review and commit) finished.",
        lines: [hub("complete_task", { delivered: true, key: "wrap", summary: "Built and committed" })],
      },
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

describe("a message to a member waiting on an approval", () => {
  // covers OR-002, IN-001, PE-003
  it("[TC-OR-487] Frodo's message to Quill while Quill's turn waits for your approval says it is held and why, and reaches Quill once you decide", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run, requests, answers, reactions } = hubbed;
    reactions.push({
      on: "Hob frodo sent you a message",
      lines: [hub("complete_task", { delivered: true, key: "ship-done", summary: "Shipped with the new name" })],
    });
    await run(
      send([
        "Ship the copy",
        hub("delegate_task", { key: "ship", hob: "Quill", brief: "Ship it\nfake:tool Bash git push origin feature" }),
        hub("wait_for", { key: "wait", tasks: ["$ship.task_id"] }),
      ]),
    );
    // Balanced asks you before Quill pushes; his turn waits on it.
    const pending = await run(firstPending);
    const quill = ownedBy(await run(treeWhen(() => true)), QUILL);
    if (quill === undefined) throw new Error("no member Task");
    expect(pending.taskId).toBe(quill.id);

    await run(messagesWhen((all) => all.length >= 2));
    await run(
      send([
        "Tell Quill the product is renamed",
        hub("message_task", {
          key: "rename",
          task_id: quill.id,
          text: "The product is now Hobbots.",
          delivery: "next-turn",
        }),
      ]),
    );
    await run(messagesWhen(() => answers.has("rename")));
    const held = answers.get("rename") ?? "";
    expect(held).toContain(`Held for hob quill on Task ${quill.id}`);
    expect(held).toContain(`their turn waits for the user to decide their request "${pending.label}"`);
    expect(held).toContain('"held":"approval-pending"');
    expect(held).toContain(`"approval_id":"${pending.id}"`);
    // Held, not lost: nothing reached Quill yet, and the note is recorded.
    expect(requests.filter((each) => each.prompt.includes("Hob frodo sent you a message"))).toHaveLength(0);
    expect((await run(treeWhen(() => true))).notes.map((note) => note.text)).toEqual(["The product is now Hobbots."]);

    // Once you decide, Quill's turn ends and his next one carries the message, which he acts on.
    await run(
      ApprovalService.use((approvals) =>
        approvals.decide(pending.id, { decision: "approve", actionDigest: pending.actionDigest }),
      ),
    );
    const done = await run(treeWhen((tree) => ownedBy(tree, QUILL)?.state === "completed"));
    expect(ownedBy(done, QUILL)?.result?.summary).toBe("Shipped with the new name");
    expect(requests.filter((each) => each.prompt.includes("Hob frodo sent you a message"))).toHaveLength(1);
  }, 30_000);

  // covers OR-002, IN-001
  it("[TC-OR-488] a message to a member whose turn runs, with no approval, says it is held until that turn ends", async () => {
    const tools = toolsHub(party, TOP);
    dispose = tools.dispose;
    const { pip, nettle } = await nested(tools);
    const { call, run, tree, startTurn } = tools;
    const queued = (await tree()).tasks.find((task) => task.id === nettle);
    if (queued === undefined) throw new Error("no nested Task");
    await run(startTurn(nettle, queued.revision));
    const sent = await call(PIP, pip, "message_task", {
      key: "go",
      task_id: nettle,
      text: "Go on.",
      delivery: "next-turn",
    });
    expect(sent.message).toContain(`Held for hob nettle on Task ${nettle}: they are in a turn now`);
    expect(sent.details).toMatchObject({ recipient: NETTLE, held: "turn-running" });
    expect(sent.details).not.toHaveProperty("approval_id");
  });
});

describe("a message to a member whose turn runs", () => {
  // covers OR-007
  it("[TC-OR-1345-05] a message sent with no delivery to a member whose turn runs reaches it at its next step", async () => {
    const tools = toolsHub(party, TOP);
    dispose = tools.dispose;
    const { pip, nettle } = await nested(tools);
    const { call, run, tree, startTurn } = tools;
    const queued = (await tree()).tasks.find((task) => task.id === nettle);
    if (queued === undefined) throw new Error("no nested Task");
    await run(startTurn(nettle, queued.revision));
    const sent = await call(PIP, pip, "message_task", { key: "go", task_id: nettle, text: "Go on." });
    expect(sent.message).toContain("it reaches them at its next step, between two tool calls");
    expect(sent.details).toMatchObject({ recipient: NETTLE, turn_running: true, delivery: "steer" });
    expect(sent.details).not.toHaveProperty("held");
    expect((await tree()).notes.map((note) => note.delivery)).toEqual(["steer"]);
  });

  // covers OR-007, RT-002
  it("[TC-OR-1345-06] a steered message to a member whose runtime cannot take one while a turn runs interrupts that turn, and says why", async () => {
    const tools = toolsHub(party, TOP, Layer.succeed(RuntimeAdapter, { ...makeFakeRuntime(), steersTurns: false }));
    dispose = tools.dispose;
    const { pip, nettle } = await nested(tools);
    const { call, run, tree, startTurn } = tools;
    const queued = (await tree()).tasks.find((task) => task.id === nettle);
    if (queued === undefined) throw new Error("no nested Task");
    await run(startTurn(nettle, queued.revision));
    const sent = await call(PIP, pip, "message_task", { key: "go", task_id: nettle, text: "Go on." });
    expect(sent.message).toContain("Their runtime cannot take a message while a turn runs, so their turn stops now");
    expect(sent.details).toMatchObject({ turn_running: true, delivery: "interrupt" });
    expect((await tree()).notes.map((note) => note.delivery)).toEqual(["interrupt"]);
  });
});

describe("a lead reads its Quest after it ends", () => {
  // covers OR-002, OR-006
  it("[TC-OR-472] once the request completes, its lead's chat turn still reads the finished tree, and every changing tool is refused", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run, answers, reactions } = hubbed;
    reactions.push({
      on: "(Build the frontend) finished.",
      lines: [hub("complete_task", { delivered: true, key: "wrap", summary: "The app is built" })],
    });
    await run(
      send([
        "Build the app",
        hub("delegate_task", {
          key: "frontend",
          hob: "Rook",
          brief: [
            "Build the frontend",
            hub("complete_task", { delivered: true, key: "rook-done", summary: "Frontend built" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$frontend.task_id"] }),
      ]),
    );
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const rook = ownedBy(done, ROOK);
    if (rook === undefined) throw new Error("no member Task");
    await run(messagesWhen(() => true));
    const before = await run(treeWhen(() => true));

    // You ask Frodo about the finished work; he reads it, and nothing he tries changes it.
    await run(
      send([
        "Why does the Quest say 1 of 1?",
        hub("read_tasks", { key: "after" }),
        hub("message_task", { key: "poke", task_id: rook.id, text: "Anything left?" }),
        hub("complete_task", { delivered: true, key: "again", summary: "Built again" }),
      ]),
    );
    await run(messagesWhen(() => answers.has("again")));
    const read = answers.get("after") ?? "";
    expect(read).toContain(String(rook.id));
    expect(read).toContain('"state":"completed"');
    expect(read).toContain("Frontend built");
    expect(read).toContain(`ended as completed, so nothing under it changes now`);
    expect(answers.get("poke") ?? "").not.toContain("Sent to hob");
    expect(answers.get("again")).toContain("not working on a Task");
    const after = await run(treeWhen(() => true));
    const shape = (tree: typeof after) => tree.tasks.map((task) => [task.id, task.state, task.result?.summary]);
    expect(shape(after)).toEqual(shape(before));
    expect(after.notes).toEqual(before.notes);
  }, 30_000);
});

import { ApprovalService, ChatService, HobLifecycle, TaskControls } from "@hobbots/agents";
import { isResumable, type Message, type MessageId, steerReceipt, type TaskNote, type TaskTree } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { EventJournal } from "@hobbots/persistence";
import { Effect } from "effect";
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
  send,
  threadId,
  treeWhen,
} from "./party-hub.ts";

// Issue #900: a note you send to the lead while a Quest runs gets a steer receipt that follows it,
// "Frodo got it → passing to Pip → Pip picked it up". The hub records which message of yours each
// note the lead sent traces back to, and which turn of its recipient picked it up.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/**
 * A delegation whose member reports a blocker and stops, so its Task waits for word from its lead:
 * its milestone is never reached, so the end of its turn does not complete it.
 */
const stuck = (key: string, hob: string, brief: string) =>
  hub("delegate_task", {
    key,
    hob,
    milestones: ["Settled"],
    brief: [
      brief,
      hub("report_checkpoint", { key: `${key}-stuck`, kind: "blocker", summary: "The design is not settled" }),
    ].join("\n"),
  });

/** Your message that starts with `text`, and the reply whose turn read it. */
const yours = (all: ReadonlyArray<Message>, text: string) => {
  const message = all.find((each) => each.role === "user" && each.content.startsWith(text));
  if (message === undefined) throw new Error(`no message "${text}"`);
  return { message, reply: all.find((each) => each.role === "assistant" && each.promptId === message.id) };
};

/**
 * The thread once the lead's turn on your message that starts with `text` has replied. A blocker
 * can start a turn of the lead's before yours, so a count of messages may end before that reply.
 */
const answeredTo = (text: string) =>
  messagesWhen((all) => {
    const message = all.find((each) => each.role === "user" && each.content.startsWith(text));
    return message !== undefined && all.some((each) => each.role === "assistant" && each.promptId === message.id);
  });

/**
 * Continue on the reply, once its turn has let go of the thread: until then Continue refuses it as
 * not resumable. Waits on that state with a time limit; any other failure ends the wait at once.
 */
const resume = (replyId: MessageId) =>
  waitUntil(
    ChatService.use((chat) => chat.continueReply(threadId, replyId)).pipe(
      Effect.catchTag("ReplyNotResumable", () => Effect.succeed(null)),
    ),
    (continued) => continued !== null,
    { what: "the cut-off reply to be continued" },
  );

const picked = (note: TaskNote) => note.pickedUpBy !== null;

/** The tree once every note that traces back to `messageId` has been picked up, and there are `count`. */
const pickedUp = (messageId: string, count: number) =>
  treeWhen((tree) => {
    const traced = tree.notes.filter((note) => note.messageId === messageId);
    return traced.length === count && traced.every(picked);
  });

/** Every journaled note event, in order, with the note's revision and the event's sequence and correlation. */
const noteEvents = EventJournal.use((journal) => journal.readAfter(0, 10_000)).pipe(
  Effect.map((entries) =>
    entries.flatMap((entry) =>
      entry.payload._tag === "NoteLeft" || entry.payload._tag === "NotePickedUp"
        ? [
            {
              type: entry.payload._tag,
              noteId: entry.payload.note.id,
              revision: entry.payload.note.revision,
              sequence: entry.sequence,
              messageId: entry.correlation.messageId,
              threadId: entry.correlation.threadId,
            },
          ]
        : [],
    ),
  ),
);

/** Whether `turnId` is the id of an Attempt in the tree, as a member's session turn is. */
const attemptIn = (tree: TaskTree, turnId: string) => tree.attempts.some((attempt) => attempt.id === turnId);

describe("a steer receipt for a message you send the lead", () => {
  // covers OR-002, IN-001, UX-006
  it("[TC-OR-540] a note passed to one member names your message, the turn that read it and the member's turn that picked it up", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run } = hubbed;
    await run(
      send([
        "Build the site",
        stuck("pages", "Pip", "Build the pages"),
        hub("wait_for", { key: "wait", tasks: ["$pages.task_id"] }),
      ]),
    );
    const blocked = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "blocked"));
    const pip = ownedBy(blocked, PIP);
    if (pip === undefined) throw new Error("no member Task");
    await run(messagesWhen((all) => all.length >= 2));

    await run(
      send(["Use the blue theme", hub("message_task", { key: "steer", task_id: pip.id, text: "Use the blue theme." })]),
    );
    const all = await run(answeredTo("Use the blue theme"));
    const { message, reply } = yours(all, "Use the blue theme");
    // The reply records the message of yours its turn answered; the first one answered yours too.
    expect(reply?.promptId).toBe(message.id);
    expect(yours(all, "Build the site").reply).toBeDefined();

    const tree = await run(pickedUp(message.id, 1));
    const [passed, ...others] = steerReceipt([tree], message.id);
    expect(others).toEqual([]);
    expect(passed?.note).toMatchObject({
      taskId: pip.id,
      senderId: FRODO,
      recipientId: PIP,
      messageId: message.id,
      fromNoteId: null,
    });
    expect(passed?.passedOn).toEqual([]);
    if (passed?.receipt._tag !== "PickedUp") throw new Error(`not picked up: ${passed?.receipt._tag}`);
    // Pip's session turn picked it up: an Attempt on his Task, at the time it recorded.
    expect(attemptIn(tree, passed.receipt.turnId)).toBe(true);
    expect(passed.receipt.at).toBe(passed.note.pickedUpAt);

    // The journal says so too, each event correlated with your message (ADR 013).
    // Each event carries the note at its own sequence, and is in the thread of your message.
    const events = await run(noteEvents);
    expect(events.map(({ type, noteId, messageId, threadId: thread }) => [type, noteId, messageId, thread])).toEqual([
      ["NoteLeft", passed.note.id, message.id, threadId],
      ["NotePickedUp", passed.note.id, message.id, threadId],
    ]);
    expect(events.every((each) => each.revision === each.sequence)).toBe(true);
    expect(events.at(-1)?.revision).toBe(passed.note.revision);
  }, 30_000);

  // covers OR-002, IN-001, UX-006
  it("[TC-OR-541] a note passed to two members gives the message two lines, each picked up by its own member", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run } = hubbed;
    await run(
      send([
        "Ship the launch",
        stuck("copy", "Quill", "Write the copy"),
        stuck("pages", "Pip", "Build the pages"),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id", "$pages.task_id"] }),
      ]),
    );
    const blocked = await run(
      treeWhen((tree) => ownedBy(tree, QUILL)?.state === "blocked" && ownedBy(tree, PIP)?.state === "blocked"),
    );
    const [quill, pip] = [ownedBy(blocked, QUILL), ownedBy(blocked, PIP)];
    if (quill === undefined || pip === undefined) throw new Error("no member Tasks");
    await run(messagesWhen((all) => all.length >= 2));

    await run(
      send([
        "Launch on Friday",
        hub("message_task", { key: "tell-quill", task_id: quill.id, text: "We launch on Friday." }),
        hub("message_task", { key: "tell-pip", task_id: pip.id, text: "We launch on Friday." }),
      ]),
    );
    const { message } = yours(await run(answeredTo("Launch on Friday")), "Launch on Friday");
    const tree = await run(pickedUp(message.id, 2));
    const receipt = steerReceipt([tree], message.id);
    expect(receipt.map((each) => each.note.recipientId)).toEqual([QUILL, PIP]);
    expect(receipt.map((each) => each.receipt._tag)).toEqual(["PickedUp", "PickedUp"]);
    // Each member's own turn picked its note up.
    const turns = receipt.map((each) => (each.receipt._tag === "PickedUp" ? each.receipt.turnId : ""));
    expect(new Set(turns).size).toBe(2);
    expect(turns.every((turnId) => attemptIn(tree, turnId))).toBe(true);
  }, 30_000);

  // covers OR-002, UX-006
  it("[TC-OR-542] a lead that answers without passing anything on leaves the receipt at the turn that read it", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run } = hubbed;
    await run(
      send([
        "Build the site",
        stuck("pages", "Pip", "Build the pages"),
        hub("wait_for", { key: "wait", tasks: ["$pages.task_id"] }),
      ]),
    );
    await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "blocked"));
    await run(messagesWhen((all) => all.length >= 2));

    await run(send(["How is it going?", hub("read_tasks", { key: "look" })]));
    const all = await run(answeredTo("How is it going?"));
    const { message, reply } = yours(all, "How is it going?");
    expect(reply?.promptId).toBe(message.id);
    expect(reply?.status).toBe("complete");
    const tree = await run(treeWhen(() => true));
    expect(steerReceipt([tree], message.id)).toEqual([]);
    expect(tree.notes).toEqual([]);
  }, 30_000);

  // covers OR-002, IN-001, UX-006
  it("[TC-OR-543] a note passed through a nested lead traces back to your message at each level", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run, reactions } = hubbed;
    reactions.push({
      on: "Hob frodo sent you a message",
      lines: [hub("message_task", { key: "tell-nettle", task_id: "$commit.task_id", text: "Commit now." })],
    });
    await run(
      send([
        "Build and commit the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review and commit",
            stuck("commit", "Nettle", "Make the commit"),
            hub("wait_for", { key: "pip-wait", tasks: ["$commit.task_id"] }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const blocked = await run(treeWhen((tree) => ownedBy(tree, NETTLE)?.state === "blocked"));
    const pip = ownedBy(blocked, PIP);
    if (pip === undefined) throw new Error("no nested Quest");
    await run(messagesWhen((all) => all.length >= 2));

    await run(
      send([
        "git init is done",
        hub("message_task", { key: "tell-pip", task_id: pip.id, text: "git init is done. Tell Nettle." }),
      ]),
    );
    const { message } = yours(await run(answeredTo("git init is done")), "git init is done");
    const tree = await run(pickedUp(message.id, 2));
    const [toPip, ...others] = steerReceipt([tree], message.id);
    expect(others).toEqual([]);
    expect(toPip?.note).toMatchObject({ senderId: FRODO, recipientId: PIP, messageId: message.id, fromNoteId: null });
    expect(toPip?.receipt._tag).toBe("PickedUp");
    // Pip passed it on from the turn that picked it up, and Nettle's own turn picked that up.
    const [toNettle] = toPip?.passedOn ?? [];
    expect(toNettle?.note).toMatchObject({
      senderId: PIP,
      recipientId: NETTLE,
      messageId: message.id,
      fromNoteId: toPip?.note.id,
    });
    expect(toNettle?.receipt._tag).toBe("PickedUp");
    expect(toNettle?.passedOn).toEqual([]);
  }, 30_000);

  // covers OR-002, IN-001, PE-003, UX-006
  it("[TC-OR-544] a note held while the member's turn waits on your approval shows as held, with the request, until a turn picks it up", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run, reactions } = hubbed;
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
    const pending = await run(firstPending);
    const quill = ownedBy(await run(treeWhen(() => true)), QUILL);
    if (quill === undefined) throw new Error("no member Task");
    await run(messagesWhen((all) => all.length >= 2));

    await run(
      send([
        "Tell Quill the product is renamed",
        hub("message_task", { key: "rename", task_id: quill.id, text: "The product is now Hobbots." }),
      ]),
    );
    const { message } = yours(await run(answeredTo("Tell Quill")), "Tell Quill");
    const held = steerReceipt([await run(treeWhen(() => true))], message.id);
    expect(held.map((each) => each.receipt)).toEqual([
      { _tag: "Held", reason: "approval-pending", approvalId: pending.id },
    ]);
    expect(held[0]?.note.pickedUpBy).toBeNull();

    // Once you decide, Quill's turn ends and his next one picks the note up.
    await run(
      ApprovalService.use((approvals) =>
        approvals.decide(pending.id, { decision: "approve", actionDigest: pending.actionDigest }),
      ),
    );
    const tree = await run(pickedUp(message.id, 1));
    expect(steerReceipt([tree], message.id).map((each) => each.receipt._tag)).toEqual(["PickedUp"]);
  }, 30_000);

  // covers OR-002, OR-006, IN-001, UX-004
  it("[TC-OR-545] a note whose member's Task is reassigned before any turn picked it up shows as unread, even once the new owner works", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run } = hubbed;
    await run(
      send([
        "Build the site",
        stuck("pages", "Pip", "Build the pages"),
        hub("wait_for", { key: "wait", tasks: ["$pages.task_id"] }),
      ]),
    );
    const blocked = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "blocked"));
    const pip = ownedBy(blocked, PIP);
    if (pip === undefined) throw new Error("no member Task");
    await run(messagesWhen((all) => all.length >= 2));

    // Pip rests, so the note waits for his next turn, which never comes: his Task goes to Quill.
    await run(HobLifecycle.use((hobs) => hobs.pause(PIP)));
    await run(
      send(["Use the blue theme", hub("message_task", { key: "steer", task_id: pip.id, text: "Use the blue theme." })]),
    );
    const { message } = yours(await run(answeredTo("Use the blue theme")), "Use the blue theme");
    const waiting = await run(treeWhen((tree) => tree.notes.some((note) => note.messageId === message.id)));
    expect(steerReceipt([waiting], message.id).map((each) => each.receipt)).toEqual([{ _tag: "Sent" }]);

    await run(TaskControls.use((controls) => controls.reassign(pip.id, QUILL)));
    // Quill takes the Task and works on it; the note was Pip's, so nobody picks it up.
    const moved = await run(
      treeWhen((tree) => {
        const task = tree.tasks.find((each) => each.id === pip.id);
        return task?.ownerId === QUILL && task.state === "blocked";
      }),
    );
    const [passed, ...others] = steerReceipt([moved], message.id);
    expect(others).toEqual([]);
    expect(passed?.note).toMatchObject({ recipientId: PIP, pickedUpBy: null });
    expect(passed?.receipt).toEqual({ _tag: "Unread" });
  }, 30_000);
  // covers OR-002, UX-006
  it("[TC-OR-546] a Task the lead delegates on your message carries it on, so the receipt names the member that picked it up (#1005)", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run } = hubbed;
    await run(
      send([
        "Build the site",
        stuck("pages", "Pip", "Build the pages"),
        hub("wait_for", { key: "wait", tasks: ["$pages.task_id"] }),
      ]),
    );
    await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "blocked"));
    await run(messagesWhen((all) => all.length >= 2));

    await run(
      send([
        "Keep the report under one page",
        hub("delegate_task", { key: "report", hob: "Quill", brief: "Write a one-page report" }),
      ]),
    );
    const all = await run(answeredTo("Keep the report under one page"));
    const { message } = yours(all, "Keep the report under one page");
    const tree = await run(pickedUp(message.id, 1));
    const quill = ownedBy(tree, QUILL);
    const [passed, ...others] = steerReceipt([tree], message.id);
    expect(others).toEqual([]);
    expect(passed?.note).toMatchObject({
      taskId: quill?.id,
      senderId: FRODO,
      recipientId: QUILL,
      messageId: message.id,
      fromNoteId: null,
    });
    // It carries what you wrote, which the fake runtime reads its scripted calls from too.
    expect(passed?.note.text.startsWith("Keep the report under one page")).toBe(true);
    expect(passed?.receipt._tag).toBe("PickedUp");
    // The request that started the work is no note: Pip's Task carries nothing of it.
    expect(steerReceipt([tree], yours(all, "Build the site").message.id)).toEqual([]);
  }, 30_000);
  // covers OR-002, UX-006, CH-009
  it("[TC-OR-547] a steer whose reply you continue carries your words, not the Continue prompt, to the Task it delegates (#1005)", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run } = hubbed;
    // The work runs with no member yet: the hub wakes the lead once about it, and its Task is blocked
    // once that turn too leaves the Quest idle (#1081), so no turn of the lead's comes between yours.
    await run(send(["Build the site", hub("start_quest", { key: "quest", goal: "Build the site" })]));
    await run(treeWhen((tree) => tree.tasks[0]?.state === "blocked"));
    await run(messagesWhen((all) => all.some((each) => each.role === "assistant" && each.status === "complete")));

    // The reply to your steer is cut off; the turn you continue it with delegates the report.
    await run(
      send([
        "Keep the report under one page",
        "fake:fail",
        `fake:then ${hub("delegate_task", { key: "report", hob: "Quill", brief: "Write a one-page report" })}`,
      ]),
    );
    const cut = await run(
      messagesWhen((all) => {
        const message = all.find((each) => each.role === "user" && each.content.startsWith("Keep the report"));
        return all.some((each) => each.promptId === message?.id && isResumable(each.status));
      }),
    );
    const { message, reply } = yours(cut, "Keep the report under one page");
    if (reply === undefined) throw new Error("no reply");
    await run(resume(reply.id));

    const tree = await run(pickedUp(message.id, 1));
    const [passed, ...others] = steerReceipt([tree], message.id);
    expect(others).toEqual([]);
    expect(passed?.note).toMatchObject({ recipientId: QUILL, messageId: message.id, fromNoteId: null });
    expect(passed?.note.text.startsWith("Keep the report under one page")).toBe(true);
    expect(passed?.note.text).not.toContain("cut off");
  }, 30_000);

  // covers OR-002, UX-006, CH-009
  it("[TC-OR-548] the request that started the work carries nothing, even when the turn you continue on it delegates (#1005)", async () => {
    const hubbed = partyHub();
    dispose = hubbed.dispose;
    const { run } = hubbed;
    // The request's turn starts the Quest and is cut off; the turn you continue it with delegates.
    await run(
      send([
        "Write the report",
        hub("start_quest", { key: "quest", goal: "Write the report" }),
        "fake:fail",
        `fake:then ${hub("delegate_task", { key: "report", hob: "Quill", brief: "Write the report" })}`,
      ]),
    );
    const cut = await run(messagesWhen((all) => all.some((each) => isResumable(each.status))));
    const { message, reply } = yours(cut, "Write the report");
    if (reply === undefined) throw new Error("no reply");
    await run(resume(reply.id));

    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "completed"));
    expect(tree.notes).toEqual([]);
    expect(steerReceipt([tree], message.id)).toEqual([]);
  }, 30_000);
});

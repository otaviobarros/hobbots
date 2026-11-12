import { ApprovalRepository, ApprovalService } from "@hobbots/agents";
import type { AgentId, TaskTree } from "@hobbots/domain";
import { EventJournal } from "@hobbots/persistence";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { firstPending, hub, isLive, messagesWhen, ownedBy, PIP, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// Issue #1345: a lead corrects a member whose turn runs. With `steer`, the message reaches the member
// at the turn's next step, between two tool calls, in the same turn; with `interrupt`, the turn stops
// and the next one starts with the message first. Either way the note records when it was sent and
// when it reached the member. The fake runtime takes a steered message before its next scripted hub
// call, so a turn that has no call left gets it in its next turn.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** Holds each call keyed `keys` until the returned function opens it by its key. */
const gated = (gates: Map<string, () => Promise<void>>, keys: ReadonlyArray<string>) => {
  const opens = new Map<string, () => void>();
  for (const key of keys) {
    const opened = new Promise<void>((resolve) => opens.set(key, resolve));
    gates.set(key, () => opened);
  }
  return (key: string) => opens.get(key)?.();
};

/** How a member's turn shows a message that a continuation carried, as Hobbots writes it. */
const CARRIED = "Hob frodo sent you a message";
/** How a member's running turn is told of a message handed to it at its next step. */
const STEERED = "A message arrived for you while you work, so it reaches you now, in this turn";

/** The hob's Task's Attempts. */
const attemptsOf = (tree: TaskTree, agentId: AgentId) => {
  const task = ownedBy(tree, agentId);
  return tree.attempts.filter((each) => each.taskId === task?.id);
};

/** The journal's events, in order, as `<type>` or `<type>:<detail>` for the ones a test follows. */
const journal = EventJournal.use((events) => events.readAfter(0, 10_000)).pipe(
  Effect.map((entries) =>
    entries.map((entry) => {
      const payload = entry.payload;
      if (payload._tag === "CheckpointRecorded") return `CheckpointRecorded:${payload.checkpoint.summary}`;
      if (payload._tag === "TaskStateChanged") return `TaskStateChanged:${payload.task.ownerId}:${payload.task.state}`;
      return payload._tag;
    }),
  ),
);

/** Whether `first` comes before `second` in the events, both found. */
const precedes = (events: ReadonlyArray<string>, first: string, second: string) => {
  const [a, b] = [events.indexOf(first), events.indexOf(second)];
  return a >= 0 && b >= 0 && a < b;
};

describe("a lead steers a member whose turn runs", () => {
  // covers OR-007, OR-003, IN-001
  it("[TC-OR-1345-01] a steered message reaches the member between two tool calls in the same turn, and the note records when", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, answers, gates } = party;
    const open = gated(gates, ["second"]);
    await run(
      send([
        "Write the report",
        hub("delegate_task", {
          key: "report",
          hob: "Pip",
          brief: [
            "Write the report to ./out",
            hub("report_checkpoint", { key: "first", kind: "progress", summary: "Read the data" }),
            hub("report_checkpoint", { key: "second", kind: "progress", summary: "Drafted the report" }),
            hub("complete_task", { delivered: true, key: "pip-done", summary: "Report written" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$report.task_id"] }),
      ]),
    );
    // Pip's turn runs, held before his second call.
    const running = await run(
      treeWhen((tree) => attemptsOf(tree, PIP).some((each) => isLive(each.state)) && tree.checkpoints.length > 0),
    );
    const pip = ownedBy(running, PIP);
    if (pip === undefined) throw new Error("no member Task");
    await run(messagesWhen((all) => all.length >= 2));

    await run(
      send([
        "Use ./reports",
        hub("message_task", { key: "steer", task_id: pip.id, text: "Write it to ./reports, not ./out." }),
      ]),
    );
    await run(messagesWhen(() => answers.has("steer")));
    expect(answers.get("steer")).toContain(
      `Sent to hob pip on Task ${pip.id}. They are in a turn, so it reaches them at its next step, between two tool calls.`,
    );
    expect(answers.get("steer")).toContain('"delivery":"steer"');
    open("second");

    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed"));
    const [attempt, ...others] = attemptsOf(done, PIP);
    expect(others).toEqual([]);
    const [note] = done.notes;
    expect(note).toMatchObject({ taskId: pip.id, delivery: "steer", pickedUpBy: attempt?.id });
    expect(note?.pickedUpAt !== null && note !== undefined && note.pickedUpAt >= note.createdAt).toBe(true);
    // It reached Pip's turn after his second call and before he completed, and no other turn carried it.
    const events = await run(journal);
    expect(precedes(events, "CheckpointRecorded:Drafted the report", "NotePickedUp")).toBe(true);
    expect(precedes(events, "NotePickedUp", "TaskCompleted")).toBe(true);
    expect(requests.filter((each) => each.prompt.includes(CARRIED))).toHaveLength(0);
  }, 30_000);

  // covers OR-007, OR-003, IN-001
  it("[TC-OR-1345-02] an interrupting message stops the member's turn and restarts it with the message first", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, answers, gates, reactions } = party;
    gated(gates, ["second"]);
    reactions.push({
      on: CARRIED,
      lines: [hub("complete_task", { delivered: true, key: "pip-redone", summary: "Report written to ./reports" })],
    });
    await run(
      send([
        "Write the report",
        hub("delegate_task", {
          key: "report",
          hob: "Pip",
          brief: [
            "Write the report to ./out",
            hub("report_checkpoint", { key: "first", kind: "progress", summary: "Read the data" }),
            hub("report_checkpoint", { key: "second", kind: "progress", summary: "Wrote to ./out" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$report.task_id"] }),
      ]),
    );
    const running = await run(
      treeWhen((tree) => attemptsOf(tree, PIP).some((each) => isLive(each.state)) && tree.checkpoints.length > 0),
    );
    const pip = ownedBy(running, PIP);
    if (pip === undefined) throw new Error("no member Task");
    await run(messagesWhen((all) => all.length >= 2));

    await run(
      send([
        "Stop, use ./reports",
        hub("message_task", {
          key: "stop",
          task_id: pip.id,
          text: "Stop writing to ./out; use ./reports.",
          delivery: "interrupt",
        }),
      ]),
    );
    await run(messagesWhen(() => answers.has("stop")));
    expect(answers.get("stop")).toContain(
      `Sent to hob pip on Task ${pip.id}. Their turn stops now and starts again with your message first`,
    );

    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed"));
    expect(ownedBy(done, PIP)?.result?.summary).toBe("Report written to ./reports");
    // The held call never ran: the turn stopped before it.
    expect(done.checkpoints.map((each) => each.summary)).not.toContain("Wrote to ./out");
    // The turn that restarted goes on in the same Attempt, and read the message first.
    const [attempt, ...others] = attemptsOf(done, PIP);
    expect(others).toEqual([]);
    expect(done.notes[0]).toMatchObject({ delivery: "interrupt", pickedUpBy: attempt?.id });
    const restarted = requests.filter((each) => each.prompt.includes(CARRIED));
    expect(restarted).toHaveLength(1);
    const prompt = restarted[0]?.prompt ?? "";
    const firstItem = prompt.split("\n").find((line) => line.startsWith("- "));
    expect(firstItem).toContain("Stop writing to ./out; use ./reports.");
    const events = await run(journal);
    expect(precedes(events, "TaskStateChanged:pip:waiting", "NotePickedUp")).toBe(true);
  }, 30_000);

  // covers OR-007, IN-001
  it("[TC-OR-1345-03] a steered message that reaches a turn after its last tool call goes to the member's next turn", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, answers, gates, reactions } = party;
    const open = gated(gates, ["stuck"]);
    reactions.push({
      on: CARRIED,
      lines: [hub("complete_task", { delivered: true, key: "pip-done", summary: "Used the blue theme" })],
    });
    await run(
      send([
        "Build the pages",
        hub("delegate_task", {
          key: "pages",
          hob: "Pip",
          brief: [
            "Build the pages",
            hub("report_checkpoint", { key: "stuck", kind: "blocker", summary: "Which theme?" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$pages.task_id"] }),
      ]),
    );
    const running = await run(treeWhen((tree) => attemptsOf(tree, PIP).some((each) => isLive(each.state))));
    const pip = ownedBy(running, PIP);
    if (pip === undefined) throw new Error("no member Task");
    await run(messagesWhen((all) => all.length >= 2));

    await run(send(["Blue", hub("message_task", { key: "theme", task_id: pip.id, text: "Use the blue theme." })]));
    await run(messagesWhen(() => answers.has("theme")));
    expect(answers.get("theme")).toContain("If the turn ends first, it reaches them as their next turn starts.");
    // Pip's last call ends his turn: no step is left to take the message, so his next turn carries it.
    open("stuck");

    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed"));
    expect(ownedBy(done, PIP)?.result?.summary).toBe("Used the blue theme");
    expect(requests.filter((each) => each.prompt.includes(CARRIED))).toHaveLength(1);
    expect(requests.some((each) => each.prompt.includes(STEERED))).toBe(false);
    expect(done.notes[0]?.pickedUpBy).not.toBeNull();
    const events = await run(journal);
    expect(precedes(events, "CheckpointRecorded:Which theme?", "NotePickedUp")).toBe(true);
  }, 30_000);

  // covers OR-007, PE-003, IN-001
  it("[TC-OR-1345-04] a turn waiting on your approval keeps its card and gets the steered message at its next step once you decide", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, answers } = party;
    await run(
      send([
        "Ship the copy",
        hub("delegate_task", {
          key: "ship",
          hob: "Quill",
          brief: [
            "Ship it",
            "fake:tool Bash git push origin feature",
            hub("report_checkpoint", { key: "pushed", kind: "progress", summary: "Pushed" }),
            hub("complete_task", { delivered: true, key: "ship-done", summary: "Shipped" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$ship.task_id"] }),
      ]),
    );
    // Balanced asks you before Quill pushes; his turn waits on it.
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
    await run(messagesWhen(() => answers.has("rename")));
    expect(answers.get("rename")).toContain(
      `Their turn waits for the user to decide their request "${pending.label}", so it reaches them at the turn's next step once that is decided.`,
    );
    expect(answers.get("rename")).toContain(`"approval_id":"${pending.id}"`);
    // The card is still there, the same request, waiting for you.
    const still = await run(ApprovalRepository.use((approvals) => approvals.listPending));
    expect(still.map((each) => each.id)).toEqual([pending.id]);

    await run(
      ApprovalService.use((approvals) =>
        approvals.decide(pending.id, { decision: "approve", actionDigest: pending.actionDigest }),
      ),
    );
    const done = await run(treeWhen((tree) => ownedBy(tree, QUILL)?.state === "completed"));
    const [attempt, ...others] = attemptsOf(done, QUILL);
    expect(others).toEqual([]);
    expect(done.notes[0]).toMatchObject({ delivery: "steer", pickedUpBy: attempt?.id });
    const events = await run(journal);
    expect(precedes(events, "ApprovalResolved", "NotePickedUp")).toBe(true);
    expect(precedes(events, "CheckpointRecorded:Pushed", "NotePickedUp")).toBe(true);
    expect(precedes(events, "NotePickedUp", "TaskCompleted")).toBe(true);
    expect(requests.filter((each) => each.prompt.includes(CARRIED))).toHaveLength(0);
  }, 30_000);
});

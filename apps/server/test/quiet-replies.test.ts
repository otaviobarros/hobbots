import type { Message } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { hub, messagesWhen, ownedBy, PIP, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// Issue #1006: on real Claude Code, a lead's chat filled with progress during a Quest: what it
// answered itself, who finished and who it now waits on, though its prompts ask it to stay quiet. A
// reply to work that arrived, in a Quest that still runs, that brings you no question, is routine
// progress: the hub keeps it, marked quiet, and the chat leaves it out. The plan, a question passed
// up to you, the finish and every reply to a message of yours still show.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

/** A member's brief that reports a blocker and stops, so its Task waits for word from its lead. */
const stuck = (key: string, hob: string, brief: string) =>
  hub("delegate_task", {
    key,
    hob,
    milestones: ["Settled"],
    brief: [brief, hub("report_checkpoint", { key: `${key}-stuck`, kind: "blocker", summary: "Not settled yet" })].join(
      "\n",
    ),
  });

describe("a lead's routine progress", () => {
  // covers UX-006, OR-004, IN-004
  it("[TC-OR-595] a lead's reply to work that arrived while its Quest runs is kept quiet, and a reply to your message is not", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run } = party;
    await run(
      send([
        "Ship the launch",
        hub("delegate_task", { key: "copy", hob: "Quill", brief: "Write the copy" }),
        stuck("pages", "Pip", "Build the pages"),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id", "$pages.task_id"] }),
      ]),
    );
    await run(
      treeWhen((tree) => ownedBy(tree, QUILL)?.state === "completed" && ownedBy(tree, PIP)?.state === "blocked"),
    );
    // Quill's result and Pip's blocker wake Frodo, who writes about them: progress the room shows.
    const woken = await run(
      messagesWhen((all) => continuations(all).some((each) => each.status === "complete" && each.content !== "")),
    );
    const [plan] = woken.filter((each) => each.role === "assistant");
    expect(plan?.quiet).toBe(false);
    const progress = continuations(woken).filter((each) => each.status === "complete");
    expect(progress.length).toBeGreaterThan(0);
    for (const each of progress) {
      expect(each.content).toContain("Echo: ");
      expect(each.quiet).toBe(true);
    }

    // You ask how it goes: the answer shows, though the Quest still runs.
    await run(send(["How is it going?"]));
    const all = await run(
      messagesWhen((each) => {
        const asked = each.find((m) => m.role === "user" && m.content === "How is it going?");
        return each.some((m) => m.promptId === asked?.id && m.status === "complete");
      }),
    );
    const asked = all.find((m) => m.role === "user" && m.content === "How is it going?");
    expect(all.find((m) => m.promptId === asked?.id)?.quiet).toBe(false);
  }, 30_000);

  // covers UX-006, OR-004, IN-004
  it("[TC-OR-596] a lead's reply that passes a question up to you, or finishes the work, still shows", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run } = party;
    await run(
      send([
        "Plan the sale",
        hub("delegate_task", {
          key: "dates",
          hob: "Pip",
          brief: ["Pick the dates", hub("ask", { key: "cutoff", question: "Which cutoff date?" })].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$dates.task_id"] }),
        `fake:then ${hub("escalate", { key: "up", question_id: "$cutoff.question_id" })}`,
      ]),
    );
    const asked = await run(
      treeWhen((tree) => tree.questions.some((each) => each.recipientId === null && each.state === "open")),
    );
    expect(asked.tasks[0]?.state).not.toBe("completed");
    const passedUp = await run(
      messagesWhen((all) =>
        continuations(all).some((each) => each.status === "complete" && each.content.includes("escalate")),
      ),
    );
    const escalated = continuations(passedUp).find((each) => each.content.includes("escalate"));
    expect(escalated?.quiet).toBe(false);
  }, 30_000);

  // covers UX-006, OR-004
  it("[TC-OR-597] a lead's finish shows, though it answers work that arrived", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run } = party;
    await run(
      send([
        "Write the launch post",
        hub("delegate_task", { key: "copy", hob: "Quill", brief: "Write the copy" }),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
        `fake:then ${hub("complete_task", { delivered: true, key: "done", summary: "The launch post is written." })}`,
      ]),
    );
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(done.tasks[0]?.result?.summary).toBe("The launch post is written.");
    const all = await run(
      messagesWhen((each) =>
        continuations(each).some((m) => m.status === "complete" && m.content.includes("complete_task")),
      ),
    );
    const finish = continuations(all).find((each) => each.content.includes("complete_task"));
    expect(finish?.quiet).toBe(false);
  }, 30_000);

  // covers UX-006, OR-004, EX-004
  it("[TC-OR-599] a lead's reply to work that arrived with a tool call that failed still shows", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run } = party;
    await run(
      send([
        "Ship the launch",
        hub("delegate_task", { key: "copy", hob: "Quill", brief: "Write the copy" }),
        stuck("pages", "Pip", "Build the pages"),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id", "$pages.task_id"] }),
        `fake:then fake:run ${JSON.stringify({ command: "pnpm deploy", output: "deploy failed", exitCode: 1 })}`,
      ]),
    );
    // Quill's result wakes Frodo, whose deploy fails: what you need to see to recover, not progress.
    const all = await run(
      messagesWhen((each) =>
        continuations(each).some(
          (m) => m.status === "complete" && m.steps.some((step) => step.kind === "tool" && step.state === "failed"),
        ),
      ),
    );
    const failed = continuations(all).find((m) => m.steps.some((step) => step.state === "failed"));
    expect(failed?.quiet).toBe(false);
  }, 30_000);
});

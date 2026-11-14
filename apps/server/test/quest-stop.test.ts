import { QuestionService } from "@hobbots/agents";
import { IDLE_QUEST, type RuntimeKind, type TaskTree } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, isLive, ownedBy, PIP, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #1346: a lead could end its Quest only by claiming it delivered, and cancel_task never
// reached the Quest's own Task, so a lead you told to stop could not, and the hub kept waking it
// with "Nobody is working on this Quest". stop_quest now ends the Quest as stopped, with the lead's
// reason and summary, only when the turn is your request. The hub checks the call, so it holds for
// every runtime.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

const STOP = { reason: "You asked me to stop", summary: "Pip started the page; nothing was delivered" };

/** Frodo hands Pip the page, whose turn holds on `hold` until the test opens it, and waits for him. */
const delegated = send([
  "Write the launch page",
  hub("delegate_task", {
    key: "page",
    hob: "Pip",
    brief: [
      "Write the launch page",
      hub("report_checkpoint", { key: "hold", kind: "progress", summary: "Writing" }),
      hub("complete_task", { key: "pip", summary: "The page is written" }),
    ].join("\n"),
  }),
  hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
]);

/**
 * Whether the Quest and its Task ended, and nothing in its tree runs any more. The Task is read as
 * well as the Quest: on PostgreSQL a tree is read one table at a time, so a read can see the Quest
 * stopped before the Task the same change cancelled.
 */
const settled = (tree: TaskTree) =>
  tree.quests[0]?.state === "stopped" &&
  tree.tasks[0]?.state === "cancelled" &&
  !tree.attempts.some((each) => isLive(each.state));

describe.each(RUNTIMES)("a lead that stops its Quest, on %s", (runtime) => {
  // covers OR-004, OR-006, EX-002
  it("[TC-OR-1346-03] ends it stopped at your request while its member runs, cancelling the member", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, answers, gates, requests } = party;
    gates.set("hold", () => new Promise<void>(() => {}));
    await run(delegated);
    await run(
      treeWhen((tree) => tree.attempts.some((each) => each.taskId === ownedBy(tree, PIP)?.id && isLive(each.state))),
    );

    await run(send(["Stop, we no longer need the page", hub("stop_quest", { key: "stop", ...STOP }), "Stopped."]));
    const done = await run(treeWhen(settled));

    expect(answers.get("stop")).toContain("stops at the user's request, without delivering it");
    const [quest] = done.quests;
    expect(quest).toMatchObject({ state: "stopped", stop: STOP });
    expect(quest?.endedAt).not.toBeNull();
    expect(done.tasks[0]).toMatchObject({ state: "cancelled", result: null });
    expect(ownedBy(done, PIP)?.state).toBe("cancelled");
    // The lead was never asked to stop its own turn, so its stop is confirmed, never unresolved.
    const lead = done.attempts.filter((each) => each.agentId === FRODO);
    expect(lead.length).toBeGreaterThan(0);
    expect(lead.every((each) => each.state !== "unresolved")).toBe(true);
    // Nothing wakes the lead about an idle Quest afterwards.
    expect(done.checkpoints.some((each) => each.summary.startsWith(IDLE_QUEST))).toBe(false);
    expect(requests.some((each) => each.prompt.includes(IDLE_QUEST))).toBe(false);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-1346-04] refuses a stop from a turn its member's result woke, with what to do instead", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, answers } = party;
    await run(
      send([
        "Write the launch page",
        hub("delegate_task", {
          key: "page",
          hob: "Pip",
          brief: ["Write the launch page", hub("complete_task", { key: "pip", summary: "The page is written" })].join(
            "\n",
          ),
        }),
        hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
        `fake:then ${hub("stop_quest", { key: "stop", ...STOP })}`,
        `fake:then ${hub("complete_task", { key: "whole", delivered: true, summary: "The page is written" })}`,
      ]),
    );
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(answers.get("stop")).toContain("Refused (stop-not-asked)");
    expect(answers.get("stop")).toContain("only the user can ask you to stop it");
    expect(answers.get("stop")).toContain("ask");
    expect(done.quests[0]).toMatchObject({ state: "completed", stop: null });
  }, 30_000);

  // covers OR-004, IN-004
  it("[TC-OR-1346-05] stops it in the turn your answer to its question wakes, and stays quiet after", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, answers, requests } = party;
    await run(
      send([
        "Write the launch page",
        hub("start_quest", { key: "quest", goal: "Write the launch page" }),
        hub("ask", { key: "ask", question: "The launch moved. Should I stop?" }),
        `fake:then ${hub("stop_quest", { key: "stop", ...STOP })}`,
      ]),
    );
    const asked = await run(treeWhen((tree) => tree.questions.some((each) => each.state === "open")));
    const question = asked.questions.find((each) => each.state === "open");
    if (question === undefined) throw new Error("no question for you");
    await run(QuestionService.use((questions) => questions.answer(question.id, "Yes, stop", "chat")));

    const done = await run(treeWhen(settled));
    expect(answers.get("stop")).toContain("stops at the user's request");
    expect(answers.get("stop")).toContain("Nothing was open under it");
    expect(done.quests[0]).toMatchObject({ state: "stopped", stop: STOP });
    expect(done.tasks[0]?.state).toBe("cancelled");
    expect(requests.some((each) => each.prompt.includes(IDLE_QUEST))).toBe(false);
  }, 30_000);
});

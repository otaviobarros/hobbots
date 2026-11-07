import { TaskControls, TaskRepository } from "@hobbots/agents";
import type { AgentId, TaskTree } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { hub, isLive, NETTLE, ownedBy, PIP, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #668: Pip, a member that leads a nested Quest, opened a new Attempt for every wake. A
// member's later turns on its Task now go on in its current Attempt, as a lead's do (#577); a
// failed turn still ends it, and Retry starts a new one.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** The Attempts of the hob's Task, by number and state. */
const attemptsOf = (tree: TaskTree, agentId: AgentId) => {
  const task = ownedBy(tree, agentId);
  return tree.attempts.filter((each) => each.taskId === task?.id).map((each) => [each.number, each.state]);
};

/** No turn is running on the hob's Task. */
const idle = (tree: TaskTree, agentId: AgentId) => {
  const task = ownedBy(tree, agentId);
  return task !== undefined && !tree.attempts.some((each) => each.taskId === task.id && isLive(each.state));
};

/** Holds each call keyed `keys` until the returned function opens it by its key. */
const gated = (gates: Map<string, () => Promise<void>>, keys: ReadonlyArray<string>) => {
  const opens = new Map<string, () => void>();
  for (const key of keys) {
    const opened = new Promise<void>((resolve) => opens.set(key, resolve));
    gates.set(key, () => opened);
  }
  return (key: string) => opens.get(key)?.();
};

describe("a member's Attempts", () => {
  // covers EX-001, OR-004, IN-004
  it("[TC-OR-450] a member that leads a nested Quest, woken three times by its member, keeps one Attempt", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, gates } = party;
    // Nettle reports each finding only once the test lets her, so each reaches Pip in a turn of its own.
    const open = gated(gates, ["second", "third", "done"]);
    const finding = (key: string, summary: string) => hub("report_checkpoint", { key, kind: "finding", summary });
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review the project",
            hub("delegate_task", {
              key: "lint",
              hob: "Nettle",
              brief: [
                "Lint the project",
                finding("first", "core.py has an unused import"),
                finding("second", "app.py has a long line"),
                finding("third", "tests.py has a typo"),
                hub("complete_task", { delivered: true, key: "done", summary: "Three lint findings" }),
              ].join("\n"),
            }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const started = await run(treeWhen((tree) => ownedBy(tree, PIP) !== undefined));
    const pip = ownedBy(started, PIP);
    if (pip === undefined) throw new Error("no Task for Pip");
    /** Pip's turns that went on in his session: each wake of his Task. */
    const wakes = () =>
      requests.filter((each) => each.sessionId !== null && each.prompt.includes(`Task ${pip.id} for`));
    const woken = (count: number) =>
      run(treeWhen((tree) => wakes().length >= count && idle(tree, PIP) && ownedBy(tree, NETTLE) !== undefined));

    await woken(1);
    await open("second");
    await woken(2);
    await open("third");
    await woken(3);
    await open("done");
    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed" && idle(tree, PIP)));

    // Every wake was a turn of Attempt 1: no Attempt to pick between in the Workbench.
    expect(wakes().length).toBeGreaterThanOrEqual(4);
    expect(attemptsOf(done, PIP)).toEqual([[1, "completed"]]);
    expect(attemptsOf(done, NETTLE)).toEqual([[1, "completed"]]);
  }, 30_000);

  // regression: a turn stopped on a defect left its Attempt live, which held the Task from any other turn
  // covers EX-001, OR-004
  it("[TC-OR-593] a member's turn that breaks on a bug ends its Attempt, and its next turn goes on", async () => {
    // Pip's turn after your answer breaks once, then goes on.
    let broken = false;
    const party = partyHub({
      announcesTwice: (prompt) => {
        // Your own script names the answer too: only Pip's turn has it and no `fake:` line.
        if (broken || !prompt.includes("Main, please") || prompt.includes("fake:")) return false;
        broken = true;
        return true;
      },
    });
    dispose = party.dispose;
    const { run, gates } = party;
    const open = gated(gates, ["main"]);
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: ["Review the project", hub("ask", { key: "which", question: "Which branch?" })].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
        `fake:then ${hub("answer", { key: "main", question_id: "$which.question_id", answer: "Main, please" })}`,
      ]),
    );
    await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "waiting" && idle(tree, PIP)));
    open("main");
    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed" && idle(tree, PIP)));
    expect(attemptsOf(done, PIP)).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
  }, 30_000);

  // covers EX-001, OR-006
  it("[TC-OR-451] a member's failed turn still ends its Attempt, and its next turn starts Attempt 2", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, reactions, gates } = party;
    const open = gated(gates, ["main"]);
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: ["Review the project", hub("ask", { key: "which", question: "Which branch?" })].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
        `fake:then ${hub("answer", { key: "main", question_id: "$which.question_id", answer: "Main, please" })}`,
      ]),
    );
    await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "waiting" && idle(tree, PIP)));
    // Pip's turn after your answer fails once, then goes on.
    reactions.push({ on: "Main, please", lines: ["fake:fail"] });
    open("main");
    // The answer resumes Attempt 1, whose failed turn ends it; the turn after starts Attempt 2.
    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed" && idle(tree, PIP)));
    expect(attemptsOf(done, PIP)).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
  }, 30_000);

  // covers EX-001, OR-006
  it("[TC-OR-452] a member's Task retried after it failed starts a new Attempt, never the one that failed", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run } = party;
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: ["Review the project", hub("ask", { key: "which", question: "Which branch?" })].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const waiting = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "waiting" && idle(tree, PIP)));
    const pip = ownedBy(waiting, PIP);
    if (pip === undefined) throw new Error("no Task for Pip");
    // The Task fails between turns, as it does when its hob is retired, and you retry it.
    await run(
      TaskRepository.use((tasks) => tasks.moveTask(pip.id, pip.revision, "failed", "2026-11-03T00:00:01.000Z")),
    );
    await run(TaskControls.use((controls) => controls.retry(pip.id)));
    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed" && idle(tree, PIP)));
    expect(attemptsOf(done, PIP)).toEqual([
      [1, "completed"],
      [2, "completed"],
    ]);
  }, 30_000);
});

import type { AgentId, RuntimeKind, TaskTree } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { hub, isLive, ownedBy, PIP, partyHub, SENT_BACK, send, treeWhen } from "./party-hub.ts";

// Issue #1086: a member's Task showed Done when its final reply said the work was not finished. A
// reply alone no longer completes it: the member is sent back once, in the same session and Attempt,
// to call complete_task or report a blocker, and a second reply blocks the Task with that reply as
// the reason its lead reads. Every runtime ends a member's turn the same way.

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

/** Frodo hands Pip a Task whose turn ends in prose, without complete_task, and waits for it. */
const delegated = send([
  "Ship the release notes",
  hub("delegate_task", { key: "notes", hob: "Pip", brief: "Write RELEASE.md, then commit it" }),
  hub("wait_for", { key: "wait", tasks: ["$notes.task_id"] }),
]);

/** The blocker a member reports when it cannot finish. */
const STUCK = { key: "stuck", kind: "blocker", summary: "The commit hook rejects RELEASE.md" } as const;

/** The summaries of the blockers on Pip's Task, oldest first. */
const blockersOf = (tree: TaskTree) => {
  const pip = ownedBy(tree, PIP);
  return tree.checkpoints
    .filter((each) => each.taskId === pip?.id && each.kind === "blocker")
    .map((each) => each.summary);
};

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

describe.each(RUNTIMES)("a member's turn that ends without complete_task, on %s", (runtime) => {
  // covers OR-004, EX-002
  it("[TC-OR-649] sends the member back once in the same session, and completes the Task only by complete_task", async () => {
    const party = partyHub({ members: runtime });
    dispose = party.dispose;
    const { run, requests } = party;
    await run(delegated);
    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed" && idle(tree, PIP)));
    const pip = ownedBy(done, PIP);
    // Its result is what it returned when sent back, never its first reply.
    expect(pip?.result?.summary).toBe("Done as briefed");
    expect(attemptsOf(done, PIP)).toEqual([[1, "completed"]]);
    const first = requests.find((each) => each.prompt.startsWith("Write RELEASE.md, then commit it\n---"));
    const [back, ...more] = requests.filter((each) => each.prompt.includes(SENT_BACK));
    expect(more).toEqual([]);
    expect(first?.sessionId).toBeNull();
    expect(back?.prompt).toContain(`Your turn on Task ${pip?.id} ended without complete_task`);
    // The same session goes on, so the member still has what it did.
    expect(back?.sessionId).not.toBeNull();
    const attempt = done.attempts.find((each) => each.taskId === pip?.id);
    expect(attempt?.sessionId).toBe(back?.sessionId);
    expect(attempt?.runtime).toBe(runtime);
  }, 30_000);

  // covers OR-004, EX-002, IN-004
  it("[TC-OR-650] blocks the Task for its lead, with the member's reply as why, when it replies again without finishing", async () => {
    const party = partyHub({ members: runtime, repliesWhenSentBack: true });
    dispose = party.dispose;
    const { run, requests } = party;
    await run(delegated);
    const blocked = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "blocked" && idle(tree, PIP)));
    const pip = ownedBy(blocked, PIP);
    expect(pip?.result).toBeNull();
    expect(attemptsOf(blocked, PIP)).toEqual([[1, "completed"]]);
    expect(blocked.attempts.find((each) => each.taskId === pip?.id)?.runtime).toBe(runtime);
    // Sent back once, and no more.
    expect(requests.filter((each) => each.prompt.includes(SENT_BACK))).toHaveLength(1);
    // Its lead reads the member's own words as the blocker, not a Task shown done.
    const blocker = blocked.checkpoints.find((each) => each.taskId === pip?.id && each.kind === "blocker");
    expect(`${blocker?.summary} ${blocker?.detail ?? ""}`).toContain("Its member's last reply: Echo:");
  }, 30_000);

  // covers OR-004, EX-002, IN-004
  it("[TC-OR-651] blocks the Task on the blocker its member reported, with no send-back and no blocker of the hub's own", async () => {
    const party = partyHub({ members: runtime });
    dispose = party.dispose;
    const { run, requests } = party;
    await run(
      send([
        "Ship the release notes",
        hub("delegate_task", {
          key: "notes",
          hob: "Pip",
          brief: ["Write RELEASE.md, then commit it", hub("report_checkpoint", STUCK)].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$notes.task_id"] }),
      ]),
    );
    const blocked = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "blocked" && idle(tree, PIP)));
    expect(requests.filter((each) => each.prompt.includes(SENT_BACK))).toEqual([]);
    expect(blockersOf(blocked)).toEqual([STUCK.summary]);
  }, 30_000);

  // covers OR-004, EX-002, IN-004
  it("[TC-OR-652] blocks the Task on the blocker its member reports once sent back, and adds none of its own", async () => {
    const party = partyHub({ members: runtime, repliesWhenSentBack: true });
    dispose = party.dispose;
    const { run, requests, reactions } = party;
    reactions.push({ on: SENT_BACK, lines: [hub("report_checkpoint", STUCK)] });
    await run(delegated);
    const blocked = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "blocked" && idle(tree, PIP)));
    expect(requests.filter((each) => each.prompt.includes(SENT_BACK))).toHaveLength(1);
    expect(blockersOf(blocked)).toEqual([STUCK.summary]);
    expect(attemptsOf(blocked, PIP)).toEqual([[1, "completed"]]);
  }, 30_000);

  // covers OR-004, EX-002
  it("[TC-OR-653] counts only what the member reported since its turn began, not a blocker an earlier turn of its Attempt cleared", async () => {
    const party = partyHub({ members: runtime });
    dispose = party.dispose;
    const { run, requests } = party;
    // Pip reports a blocker and asks Frodo, whose answer starts the turn Pip goes on in.
    await run(
      send([
        "Ship the release notes",
        hub("delegate_task", {
          key: "notes",
          hob: "Pip",
          brief: [
            "Write RELEASE.md, then commit it",
            hub("report_checkpoint", STUCK),
            hub("ask", { key: "which", question: "May I skip the commit hook?" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$notes.task_id"] }),
      ]),
    );
    const asked = await run(treeWhen((tree) => tree.questions.length === 1 && idle(tree, PIP)));
    const question = asked.questions[0];
    if (question === undefined) throw new Error("no question");
    await run(send(["Answer Pip", hub("answer", { key: "yes", question_id: question.id, answer: "Yes, skip it" })]));
    const done = await run(treeWhen((tree) => ownedBy(tree, PIP)?.state === "completed" && idle(tree, PIP)));
    // The turn after the answer was sent back and finished, rather than blocked on the old blocker.
    expect(ownedBy(done, PIP)?.result?.summary).toBe("Done as briefed");
    expect(requests.filter((each) => each.prompt.includes(SENT_BACK))).toHaveLength(1);
    expect(attemptsOf(done, PIP)).toEqual([[1, "completed"]]);
  }, 30_000);
});

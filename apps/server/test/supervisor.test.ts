import { TaskRepository } from "@hobbots/agents";
import type { RuntimeKind, Task, TaskTree } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { Supervisor } from "@hobbots/supervision";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { hub, isLive, ownedBy, PIP, partyHub, send, threadId, treeWhen } from "./party-hub.ts";

// Issue #1447: the supervisor stops a member past its deadline and tells its lead, stops a member
// whose turns keep failing, and fails a member whose runtime ran out of allowance, with no model
// call. Each runs on every runtime a member can run on, played by the fake.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

/** No turn is running on Pip's Task. */
const idle = (tree: TaskTree) => {
  const task = ownedBy(tree, PIP);
  return task !== undefined && !tree.attempts.some((each) => each.taskId === task.id && isLive(each.state));
};

/** Pip's Task in the request's tree as it is now. */
const pipTask = Effect.map(
  TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)),
  ([tree]) => (tree === undefined ? undefined : ownedBy(tree, PIP)),
);

/** Looks over the work as at `at` until Pip's Task has failed, as the supervisor does on its schedule. */
const passUntilFailed = (at?: string) =>
  waitUntil(
    Effect.andThen(
      Supervisor.use((supervisor) => supervisor.pass(at)),
      pipTask,
    ),
    (task): task is Task => task?.state === "failed",
    { what: "Pip's Task to fail" },
  );

describe.each(RUNTIMES)("the supervisor, with members on %s", (members) => {
  // covers OR-005, EX-003
  it("[TC-OR-1447-10] stops a member past its deadline, fails its Task, and tells its lead why", async () => {
    const party = partyHub({ members, supervisor: true });
    dispose = party.dispose;
    const { run, requests, gates } = party;
    // Pip's turn holds on its first call, so it is still running when its deadline passes.
    gates.set("stall", () => new Promise<void>(() => undefined));
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          timeout_minutes: 1,
          brief: ["Review the project", hub("report_checkpoint", { key: "stall", kind: "finding", summary: "x" })].join(
            "\n",
          ),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const started = await run(
      treeWhen((tree) => {
        const task = ownedBy(tree, PIP);
        return task !== undefined && tree.attempts.some((each) => each.taskId === task.id && isLive(each.state));
      }),
    );
    const pip = ownedBy(started, PIP);
    const delegation = started.delegations.find((each) => each.childTaskId === pip?.id);
    if (pip === undefined || delegation?.timeoutMs == null) throw new Error("no Task with a time limit for Pip");
    const later = new Date(Date.parse(delegation.createdAt) + delegation.timeoutMs + 60_000).toISOString();

    // Nothing is overdue yet: the supervisor leaves the running turn alone.
    expect((await run(Supervisor.use((supervisor) => supervisor.pass()))).acted).toEqual([]);

    await run(passUntilFailed(later));
    const ended = await run(treeWhen(idle));
    expect(ended.attempts.filter((each) => each.taskId === pip.id).map((each) => each.state)).toEqual(["interrupted"]);
    // Frodo, its lead, reads why in the turn its failure wakes.
    await run(
      waitUntil(
        Effect.sync(() => requests.some((each) => each.prompt.includes("passed its deadline"))),
        (told) => told,
        { what: "Frodo to be told" },
      ),
    );
  }, 30_000);

  // covers OR-006, EX-003
  it("[TC-OR-1447-11] stops a member whose turns keep failing, and its lead decides what comes next", async () => {
    const party = partyHub({ members, supervisor: true, repliesWhenSentBack: true });
    dispose = party.dispose;
    const { run, requests, reactions } = party;
    // Each turn Pip is woken to work on it fails too, as a broken setup fails every try.
    for (let turn = 0; turn < 5; turn++)
      reactions.push({ on: "(Review the project) is yours to work on", lines: ["fake:fail"] });
    await run(
      send([
        "Review the project",
        hub("delegate_task", { key: "review", hob: "Pip", brief: ["Review the project", "fake:fail"].join("\n") }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    await run(passUntilFailed());
    const ended = await run(treeWhen(idle));
    const pip = ownedBy(ended, PIP);
    const failed = ended.attempts.filter((each) => each.taskId === pip?.id && each.state === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(3);
    await run(
      waitUntil(
        Effect.sync(() => requests.some((each) => each.prompt.includes("so Hobbots stopped trying"))),
        (told) => told,
        { what: "Frodo to be told" },
      ),
    );
  }, 30_000);

  // covers OR-006, IN-007
  it("[TC-OR-1447-12] fails a member whose runtime ran out of allowance, and says when it resets", async () => {
    const party = partyHub({ members, supervisor: true });
    dispose = party.dispose;
    const { run, requests } = party;
    await run(
      send([
        "Review the project",
        hub("delegate_task", { key: "review", hob: "Pip", brief: ["Review the project", "fake:limit"].join("\n") }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    await run(passUntilFailed());
    const ended = await run(treeWhen(idle));
    const pip = ownedBy(ended, PIP);
    // The supervisor stopped it after the one turn the limit ended: nothing tried it again.
    expect(ended.attempts.filter((each) => each.taskId === pip?.id).map((each) => each.state)).toEqual(["failed"]);
    await run(
      waitUntil(
        Effect.sync(() => requests.some((each) => each.prompt.includes("The usage limit of hob"))),
        (told) => told,
        { what: "Frodo to be told" },
      ),
    );
  }, 30_000);
});

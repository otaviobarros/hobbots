import { HobLifecycle, TaskControls } from "@hobbots/agents";
import type { TaskTree } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  attemptsOf,
  hold,
  hub,
  memberTask,
  nothingOpen,
  PIP,
  promptsTo,
  QUILL,
  ROOK,
  send,
  settledTree,
  sharedDatabase,
  startHub,
  taskOf,
  treeWhen,
} from "./dependency-hub.ts";

// Issue #564: a Task delegated with depends_on starts no turn until every Task it depends on has
// completed, as a step does (ADR 018). Until then it stays queued, waiting on them; one that fails
// or is cancelled keeps it queued, and its lead hears of that.

/** Quill's backend Task, held until the test lets it go, then completed with its result. */
const backend = (name = "quill") =>
  hub("delegate_task", {
    key: "backend",
    hob: "Quill",
    brief: [
      "Write the backend",
      hold(name),
      hub("complete_task", { key: "backend-done", summary: "Backend ready" }),
    ].join("\n"),
  });

/** Rook's frontend Task, which comes after the Tasks `after` names, and completes in its first turn. */
const frontend = (after: ReadonlyArray<string>) =>
  hub("delegate_task", {
    key: "frontend",
    hob: "Rook",
    brief: ["Write the frontend", hub("complete_task", { key: "frontend-done", summary: "Frontend ready" })].join("\n"),
    depends_on: after,
  });

/** Rook's Task is still queued: no Attempt, and no prompt ever sent to his session. */
const expectQueued = (tree: TaskTree, requests: Parameters<typeof promptsTo>[0]) => {
  const rook = taskOf(tree, ROOK);
  expect(rook.state).toBe("queued");
  expect(attemptsOf(tree, rook)).toEqual([]);
  expect(promptsTo(requests, rook)).toEqual([]);
};

/** A few runner rounds, so a Task that would start early has had every chance to. */
const rounds = Effect.sleep("300 millis");

describe("a dependent Task waits for its dependencies", () => {
  // covers OR-002, OR-003
  it("[TC-OR-200] Rook's Task starts no turn while Quill's runs, then exactly one once Quill's completes", async () => {
    const { run, requests, release } = await startHub(await sharedDatabase());
    await run(send(["Build the app", backend(), frontend(["$backend.task_id"])]));

    const running = await run(
      treeWhen((tree) => memberTask(tree, QUILL)?.state === "active" && memberTask(tree, ROOK) !== undefined),
    );
    expect(taskOf(running, ROOK).dependsOn).toEqual([taskOf(running, QUILL).id]);
    await run(rounds);
    expectQueued(await run(treeWhen(() => true)), requests);

    await release("quill");
    const done = await run(settledTree((tree) => memberTask(tree, ROOK)?.state === "completed"));
    const rook = taskOf(done, ROOK);
    expect(attemptsOf(done, rook)).toEqual(["completed"]);
    expect(promptsTo(requests, rook)).toHaveLength(1);
    const started = done.attempts.find((each) => each.taskId === rook.id)?.startedAt ?? "";
    expect(started >= taskOf(done, QUILL).updatedAt).toBe(true);
    expect(rook.result?.summary).toBe("Frontend ready");
  }, 30_000);

  // covers OR-002, OR-003, OR-004
  it("[TC-OR-201] a dependency that fails or is cancelled keeps the dependent queued, its lead hears of it, and a reassignment lets it start", async () => {
    const { run, requests, release } = await startHub(await sharedDatabase());
    await run(send(["Build the app", backend(), frontend(["$backend.task_id"])]));
    await run(treeWhen((tree) => memberTask(tree, QUILL)?.state === "active" && memberTask(tree, ROOK) !== undefined));

    // Quill is retired mid-Task: his Task fails, and Rook's stays queued.
    await run(HobLifecycle.use((lifecycle) => lifecycle.retire(QUILL, "stop")));
    await release("quill");
    const failed = await run(settledTree((tree) => memberTask(tree, QUILL)?.state === "failed"));
    await run(rounds);
    expectQueued(await run(treeWhen(() => true)), requests);
    // Aldric hears of the failure, and his briefing says Rook's Task cannot start.
    await run(
      treeWhen(() =>
        requests.some((request) =>
          `${request.briefing ?? ""}${request.prompt}`.includes(
            `Task ${taskOf(failed, ROOK).id}, queued, but it cannot start because a Task it comes after did not complete`,
          ),
        ),
      ),
    );

    // Quill's Task goes to Pip and completes; only then does Rook's start, once.
    await run(TaskControls.use((controls) => controls.reassign(taskOf(failed, QUILL).id, PIP)));
    const done = await run(settledTree((tree) => memberTask(tree, ROOK)?.state === "completed"));
    expect(memberTask(done, PIP)?.state).toBe("completed");
    expect(attemptsOf(done, taskOf(done, ROOK))).toEqual(["completed"]);
  }, 30_000);

  // covers OR-002, OR-003, OR-006
  it("[TC-OR-202] a dependent of a cancelled Task stays queued until it is cancelled too, with nothing left open", async () => {
    const { run, requests } = await startHub(await sharedDatabase());
    await run(send(["Build the app", backend(), frontend(["$backend.task_id"])]));
    const running = await run(
      treeWhen((tree) => memberTask(tree, QUILL)?.state === "active" && memberTask(tree, ROOK) !== undefined),
    );

    await run(TaskControls.use((controls) => controls.cancel(taskOf(running, QUILL).id)));
    await run(settledTree((tree) => memberTask(tree, QUILL)?.state === "cancelled"));
    await run(rounds);
    expectQueued(await run(treeWhen(() => true)), requests);

    await run(TaskControls.use((controls) => controls.cancel(taskOf(running, ROOK).id)));
    const done = await run(settledTree((tree) => memberTask(tree, ROOK)?.state === "cancelled"));
    expect(attemptsOf(done, taskOf(done, ROOK))).toEqual([]);
    await run(send(["Wrap up", hub("complete_task", { key: "wrap", summary: "Nothing was built" })]));
    await run(settledTree((tree) => tree.tasks[0]?.state === "completed"));
    await run(nothingOpen);
  }, 30_000);

  // covers OR-002, OR-003
  it("[TC-OR-203] a Task that depends on two starts only once the second of them completes", async () => {
    const { run, requests, release } = await startHub(await sharedDatabase());
    await run(
      send([
        "Build the app",
        backend(),
        hub("delegate_task", {
          key: "docs",
          hob: "Pip",
          brief: [
            "Write the docs",
            hold("pip"),
            hub("complete_task", { key: "docs-done", summary: "Docs ready" }),
          ].join("\n"),
        }),
        frontend(["$backend.task_id", "$docs.task_id"]),
      ]),
    );
    await run(
      treeWhen(
        (tree) =>
          memberTask(tree, QUILL)?.state === "active" &&
          memberTask(tree, PIP)?.state === "active" &&
          memberTask(tree, ROOK) !== undefined,
      ),
    );

    // Pip's completes first: Rook's still waits on Quill's.
    await release("pip");
    await run(treeWhen((tree) => memberTask(tree, PIP)?.state === "completed"));
    await run(rounds);
    expectQueued(await run(treeWhen(() => true)), requests);

    await release("quill");
    const done = await run(settledTree((tree) => memberTask(tree, ROOK)?.state === "completed"));
    expect(attemptsOf(done, taskOf(done, ROOK))).toEqual(["completed"]);
    expect(promptsTo(requests, taskOf(done, ROOK))).toHaveLength(1);
  }, 30_000);
});

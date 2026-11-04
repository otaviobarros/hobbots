import { ApprovalRepository, TaskRepository } from "@hobbots/agents";
import { ApprovalId, ApprovalRequest, AttemptId, TaskId, ThreadId } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, NETTLE, PIP } from "./party-hub.ts";
import { toolsHub } from "./tools-hub.ts";

// Issue #698: Nettle's delete waited five minutes for the user's approval while its Task read
// active, and neither Pip nor Frodo could see why. A pending request now shows under its Task in the
// tree every lead reads: read_tasks lists it, and wait_for reports it, until the user decides it.

const TOP = TaskId.make("build");
const now = "2026-11-04T00:41:32.000Z";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const party = [
  [FRODO, "Frodo"],
  [PIP, "Pip"],
  [NETTLE, "Nettle"],
] as const;

/** Nettle's delete, asked of you from his Task under Pip's nested Quest, as a member's turn asks. */
const nettlesDelete = (taskId: TaskId) =>
  new ApprovalRequest({
    id: ApprovalId.make("nettle-rm"),
    agentId: NETTLE,
    threadId: ThreadId.make("tools-hub"),
    messageId: null,
    taskId,
    rootTaskId: TOP,
    stepId: "tool-1",
    tool: "Bash",
    operation: "delete-files",
    targets: ["/work/scratch/tmp-notes.txt"],
    arguments: { command: "rm scratch/tmp-notes.txt" },
    label: "Running rm scratch/tmp-notes.txt",
    reason: "Deleting files asks first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1",
    state: "pending",
    denyReason: null,
    createdAt: now,
    decidedAt: null,
  });

const tasksOf = (done: { readonly details: Record<string, unknown> }) =>
  done.details.tasks as ReadonlyArray<{ readonly task_id: string; readonly approvals: ReadonlyArray<unknown> }>;

describe("a member's pending approval reaches its leads", () => {
  // covers OR-002, OR-006, PE-003, PE-006
  it("[TC-OR-490] read_tasks lists the pending request under the member's Task, wait_for reports it, and both drop it once you decide", async () => {
    const tools = toolsHub(party, TOP);
    dispose = tools.dispose;
    const { run, call, seed } = tools;
    await run(seed);
    const pip = TaskId.make(
      String((await call(FRODO, TOP, "delegate_task", { key: "tidy", hob: "Pip", brief: "Tidy up" })).details.task_id),
    );
    const nettle = TaskId.make(
      String(
        (await call(PIP, pip, "delegate_task", { key: "rm", hob: "Nettle", brief: "Remove the notes" })).details
          .task_id,
      ),
    );
    // Pip's and Nettle's turns run, as they did when Nettle asked.
    for (const taskId of [pip, nettle]) {
      await run(
        Effect.gen(function* () {
          const tasks = yield* TaskRepository;
          const task = Option.getOrThrow(yield* tasks.readTree(taskId)).tasks[0];
          if (task === undefined) return;
          yield* tasks.startAttempt(taskId, task.revision, {
            id: AttemptId.make(`${taskId}-1`),
            runtime: "claude-code",
            sessionId: null,
            configVersion: 1,
            policyVersion: null,
            startedAt: now,
          });
        }),
      );
    }
    const asked = nettlesDelete(nettle);
    await run(ApprovalRepository.use((approvals) => approvals.insert(asked)));

    const waiting = {
      approval_id: "nettle-rm",
      hob: NETTLE,
      operation: "delete-files",
      action: "rm scratch/tmp-notes.txt",
      targets: ["/work/scratch/tmp-notes.txt"],
      asked_at: now,
      waits_for: "the user",
    };
    // Pip, his lead, and Frodo, two levels up, both read it under Nettle's Task.
    const pips = await call(PIP, pip, "read_tasks", { key: "read" });
    expect(tasksOf(pips)).toEqual([expect.objectContaining({ task_id: nettle, approvals: [waiting] })]);
    expect(pips.message).toContain("1 action waits for the user's approval");
    const frodos = await call(FRODO, TOP, "read_tasks", { key: "read" });
    expect(tasksOf(frodos)).toEqual([
      expect.objectContaining({ task_id: pip, approvals: [] }),
      expect.objectContaining({ task_id: nettle, approvals: [waiting] }),
    ]);

    // Waiting on Nettle, or on Pip's Task above him, reports what holds it.
    const pipWaits = await call(PIP, pip, "wait_for", { key: "wait", tasks: [nettle] });
    expect(pipWaits.details.approvals).toEqual([{ task_id: nettle, ...waiting }]);
    expect(pipWaits.message).toContain("waits for the user's approval");
    const frodoWaits = await call(FRODO, TOP, "wait_for", { key: "wait", tasks: [pip] });
    expect(frodoWaits.details.approvals).toEqual([{ task_id: nettle, ...waiting }]);

    // Once you decide it, nothing waits on you any more.
    await run(
      Effect.flatMap(ApprovalRepository, (approvals) =>
        Effect.flatMap(approvals.find(asked.id), (found) =>
          approvals.resolve(
            new ApprovalRequest({ ...Option.getOrThrow(found), state: "approved", decidedAt: now }),
            "pending",
          ),
        ),
      ),
    );
    const after = await call(PIP, pip, "read_tasks", { key: "read-after" });
    expect(tasksOf(after)).toEqual([expect.objectContaining({ task_id: nettle, approvals: [] })]);
    expect(after.message).not.toContain("approval");
    const waitsAfter = await call(PIP, pip, "wait_for", { key: "wait-after", tasks: [nettle], mode: "any" });
    expect(waitsAfter.details.approvals).toBeUndefined();
    expect((await tools.tree()).approvals).toEqual([]);
  });
});

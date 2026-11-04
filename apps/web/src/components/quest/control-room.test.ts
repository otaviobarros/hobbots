import { AgentId, Attempt, AttemptId, Delegation, Quest, QuestId, Task, TaskId, TaskWait } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import {
  ADA,
  ALDRIC,
  attempt,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  delegation,
  memberApproval,
  QUILL,
  quest,
  question,
  task,
  tree,
} from "../../test/quests.ts";
import {
  attemptCount,
  cancelOutcome,
  controlError,
  pendingStart,
  reassignTargets,
  roomRows,
  taskControls,
  topCancel,
  waitedTaskCount,
} from "./control-room.ts";
import { parsePins, sortPinnedReads } from "./use-work.ts";

const ROOK = AgentId.make("rook");

/** The Task at `index` in the tree, which the test knows is there. */
const nth = (tasks: ReadonlyArray<Task>, index: number): Task => {
  const found = tasks[index];
  if (found === undefined) throw new Error(`No Task at ${index}`);
  return found;
};
const RESEARCH = TaskId.make("research");
const NESTED = QuestId.make("quest-build");

/** Ada leads a Quest of her own under Aldric's: Rook researches keywords for her. */
const nested = () => {
  const base = blackFriday();
  return tree({
    ...base,
    tasks: [...base.tasks, task(RESEARCH, { ownerId: ROOK, parentId: BUILD, brief: "Research keywords", second: 4 })],
    quests: [...base.quests, new Quest({ ...quest(), id: NESTED, taskId: BUILD, leadId: ADA, depth: 2 })],
    delegations: [
      ...base.delegations,
      new Delegation({
        ...delegation(ROOK, RESEARCH, "Research keywords"),
        questId: NESTED,
        leadId: ADA,
        parentTaskId: BUILD,
      }),
    ],
  });
};

describe("roomRows", () => {
  it("lists every Task under its parent, nested Quests indented under their member", () => {
    const rows = roomRows(nested());
    expect(rows.map((row) => [row.task.id, row.depth, row.quest?.leadId ?? null])).toEqual([
      [CAMPAIGN, 0, null],
      [COPY, 1, null],
      [BUILD, 1, ADA],
      [RESEARCH, 2, null],
    ]);
    // The member that leads a nested Quest names its own party; the Task you asked for never does.
    expect(rows.map((row) => row.party)).toEqual([[], [], [ROOK], []]);
  });

  it("says who each Task waits on: the hobs it depends on and whoever holds its question", () => {
    const base = blackFriday();
    const wait = new TaskWait({ taskId: CAMPAIGN, on: [COPY, BUILD], mode: "all", createdAt: "2026-11-01T10:00:09Z" });
    const asking = tree({
      ...base,
      tasks: [task(CAMPAIGN, { state: "waiting" }), ...base.tasks.slice(1)],
      questions: [question(BUILD, ADA, "Dec 12 for international?", { recipientId: null })],
      waits: [wait],
    });
    const rows = roomRows(asking);
    expect(rows.find((row) => row.task.id === BUILD)?.waitingOn).toEqual([{ kind: "hob", id: QUILL }, { kind: "you" }]);
    expect(rows.find((row) => row.task.id === CAMPAIGN)?.waitingOn).toEqual([
      { kind: "hob", id: QUILL },
      { kind: "hob", id: ADA },
    ]);
    expect(rows.find((row) => row.task.id === COPY)?.waitingOn).toEqual([]);

    // The hub keeps a Task's last wait after it moves on; it no longer counts then.
    const movedOn = tree({ ...base, waits: [wait] });
    expect(roomRows(movedOn).find((row) => row.task.id === CAMPAIGN)?.waitingOn).toEqual([]);
  });

  it("counts the unfinished Tasks a waiting lead waits for, and none once it moves on", () => {
    const base = blackFriday();
    const wait = new TaskWait({ taskId: CAMPAIGN, on: [COPY, BUILD], mode: "all", createdAt: "2026-11-01T10:00:09Z" });
    const waiting = tree({
      ...base,
      tasks: [task(CAMPAIGN, { state: "waiting" }), ...base.tasks.slice(1)],
      waits: [wait],
    });
    expect(waitedTaskCount(waiting, nth(waiting.tasks, 0))).toBe(2);
    const oneDone = tree({
      ...waiting,
      tasks: waiting.tasks.map((each) => (each.id === COPY ? new Task({ ...each, state: "completed" }) : each)),
    });
    expect(waitedTaskCount(oneDone, nth(oneDone.tasks, 0))).toBe(1);
    const movedOn = tree({ ...base, waits: [wait] });
    expect(waitedTaskCount(movedOn, nth(movedOn.tasks, 0))).toBe(0);
  });

  it("says a member's Task waits on you while its turn waits on your approval, and needs you", () => {
    const asking = tree({ ...blackFriday(), approvals: [memberApproval(COPY, QUILL)] });
    const copy = roomRows(asking).find((row) => row.task.id === COPY);
    expect([copy?.status, copy?.waitingOn]).toEqual(["needs-you", [{ kind: "you" }]]);
    const decided = tree({ ...blackFriday(), approvals: [memberApproval(COPY, QUILL, { state: "denied" })] });
    expect(roomRows(decided).find((row) => row.task.id === COPY)?.waitingOn).toEqual([]);
  });

  it("shows a cancel as it is, apart from done", () => {
    const base = blackFriday();
    const cancelling = tree({
      ...base,
      tasks: [
        nth(base.tasks, 0),
        task(COPY, { ownerId: QUILL, state: "cancelling" }),
        task(BUILD, { ownerId: ADA, state: "cancelled" }),
      ],
    });
    expect(roomRows(cancelling).map((row) => row.status)).toEqual(["running", "cancelling", "cancelled"]);
  });

  it("shows a cancel whose stop was never confirmed apart from one that was", () => {
    const base = blackFriday();
    const unresolved = new Attempt({ ...attempt(BUILD, "unresolved"), agentId: ADA });
    const ended = tree({
      ...base,
      tasks: [
        nth(base.tasks, 0),
        task(COPY, { ownerId: QUILL, state: "cancelled" }),
        new Task({ ...task(BUILD, { ownerId: ADA, state: "cancelled" }), currentAttemptId: unresolved.id }),
      ],
      attempts: [unresolved],
    });
    expect(roomRows(ended).map((row) => row.status)).toEqual(["running", "cancelled", "unresolved"]);
  });
});

describe("taskControls", () => {
  it("offers Retry only on a failed Task, Reassign only on a member's, and never cancels the top Task alone", () => {
    const base = blackFriday();
    const failed = tree({
      ...base,
      tasks: [nth(base.tasks, 0), task(COPY, { ownerId: QUILL, state: "failed" }), nth(base.tasks, 2)],
    });
    const top = nth(failed.tasks, 0);
    const copy = nth(failed.tasks, 1);
    const build = nth(failed.tasks, 2);
    expect(taskControls(failed, top)).toEqual({ retry: false, reassign: false, cancel: false });
    expect(taskControls(failed, copy)).toEqual({ retry: true, reassign: true, cancel: false });
    expect(taskControls(failed, build)).toEqual({ retry: false, reassign: true, cancel: true });
  });

  it("never retries the top Task, and keeps a Task that leads a quest or has work open under it with its hob", () => {
    const base = blackFriday();
    const failedTop = tree({ ...base, tasks: [task(CAMPAIGN, { state: "failed" }), ...base.tasks.slice(1)] });
    expect(taskControls(failedTop, nth(failedTop.tasks, 0)).retry).toBe(false);
    const leading = nested();
    expect(taskControls(leading, nth(leading.tasks, 2))).toEqual({ retry: false, reassign: false, cancel: true });
  });

  it("offers nothing on a step that ended, and only Cancel on a running step", () => {
    const steps = tree({
      tasks: [task(CAMPAIGN), task(TaskId.make("outline"), { state: "completed" }), task(TaskId.make("draft"))],
    });
    const outline = nth(steps.tasks, 1);
    const draft = nth(steps.tasks, 2);
    expect(taskControls(steps, outline)).toEqual({ retry: false, reassign: false, cancel: false });
    expect(taskControls(steps, draft)).toEqual({ retry: false, reassign: false, cancel: true });
  });
});

describe("reassignTargets", () => {
  it("offers every other hob except the Task's owner and whoever owns a Task above it", () => {
    const hobs = [ALDRIC, QUILL, ADA, ROOK].map((id) => ({ id }));
    const base = nested();
    expect(reassignTargets(base, nth(base.tasks, 2), hobs).map((hob) => hob.id)).toEqual([QUILL, ROOK]);
    // Under Ada's own Quest, neither Aldric nor Ada can take Rook's research.
    expect(reassignTargets(base, nth(base.tasks, 3), hobs).map((hob) => hob.id)).toEqual([QUILL]);
  });
});

describe("cancelOutcome", () => {
  const cancelled = (states: { copy: Task["state"]; build: Task["state"]; top: Task["state"] }, unresolved = false) => {
    const stuck = new Attempt({ ...attempt(BUILD, "unresolved"), agentId: ADA });
    return tree({
      ...blackFriday(),
      tasks: [
        task(CAMPAIGN, { state: states.top }),
        task(COPY, { ownerId: QUILL, state: states.copy }),
        new Task({
          ...task(BUILD, { ownerId: ADA, state: states.build }),
          currentAttemptId: unresolved ? stuck.id : null,
        }),
      ],
      attempts: unresolved ? [stuck] : [],
    });
  };

  it("has nothing to say about work nobody cancelled", () => {
    const base = blackFriday();
    expect(cancelOutcome(base, nth(base.tasks, 0))).toBeNull();
  });

  it("counts the Tasks asked to stop and those that confirmed, apart from work that had already ended", () => {
    const asked = cancelled({ top: "cancelling", copy: "completed", build: "cancelling" });
    expect(cancelOutcome(asked, nth(asked.tasks, 0))).toEqual({
      total: 2,
      confirmed: 0,
      unresolved: 0,
      settled: false,
    });
    const halfway = cancelled({ top: "cancelling", copy: "completed", build: "cancelled" });
    expect(cancelOutcome(halfway, nth(halfway.tasks, 0))).toMatchObject({ confirmed: 1, settled: false });
    const done = cancelled({ top: "cancelled", copy: "completed", build: "cancelled" });
    expect(cancelOutcome(done, nth(done.tasks, 0))).toEqual({ total: 2, confirmed: 2, unresolved: 0, settled: true });
  });

  it("tells a stop never confirmed apart from a confirmed one", () => {
    const left = cancelled({ top: "cancelled", copy: "cancelled", build: "cancelled" }, true);
    expect(cancelOutcome(left, nth(left.tasks, 0))).toEqual({ total: 3, confirmed: 2, unresolved: 1, settled: true });
    // A member's own cancel counts only what is under it.
    expect(cancelOutcome(left, nth(left.tasks, 2))).toEqual({ total: 1, confirmed: 0, unresolved: 1, settled: true });
  });
});

describe("pendingStart", () => {
  it("waits for the new Attempt of a Task you retried or gave away, and not for one never started", () => {
    const failed = new Attempt({ ...attempt(COPY, "failed"), agentId: QUILL });
    const retried = tree({
      ...blackFriday(),
      tasks: [task(CAMPAIGN), task(COPY, { ownerId: QUILL, state: "queued" })],
      attempts: [failed],
    });
    expect(pendingStart(retried, nth(retried.tasks, 1))).toEqual({ attempt: 2 });
    const fresh = tree({ tasks: [task(CAMPAIGN), task(COPY, { ownerId: QUILL, state: "queued" })] });
    expect(pendingStart(fresh, nth(fresh.tasks, 1))).toBeNull();
    const started = tree({
      ...retried,
      attempts: [failed, new Attempt({ ...failed, id: AttemptId.make("a-copy-2"), number: 2, state: "running" })],
      tasks: [task(CAMPAIGN), task(COPY, { ownerId: QUILL, state: "active" })],
    });
    expect(pendingStart(started, nth(started.tasks, 1))).toBeNull();
  });
});

describe("controlError", () => {
  const names = { owner: "Ada", target: "Quill" };
  const refusal = (reason: string) =>
    new ApiError("TaskNotControllable", "TaskNotControllable", { reason, message: `Refused: ${reason}` });

  it("says why the hub refused, naming the hob it is about", () => {
    expect(controlError(refusal("attempt-live"), names)).toBe(
      "Ada is working on it right now. Reassign it once that turn ends.",
    );
    expect(controlError(refusal("lineage-owner"), names)).toBe(
      "Quill works on a task above this one, so it cannot take it.",
    );
    expect(controlError(refusal("task-ended"), names)).toBe("This work already ended, so there is nothing to cancel.");
    expect(controlError(new ApiError("HobUnavailable", "HobUnavailable"), names)).toBe(
      "Quill is retired, so it cannot take this work.",
    );
  });

  it("passes on the hub's words for a reason it does not know, and asks again when the hub was not reached", () => {
    expect(controlError(refusal("something-new"), names)).toBe("The hub refused this: Refused: something-new");
    expect(controlError(new ApiError("Failed to fetch", undefined), names)).toBe(
      "This could not reach the hub. Try again.",
    );
  });
});

describe("topCancel and attemptCount", () => {
  it("follows the top Task: open, cancelling until confirmed, then ended", () => {
    expect(topCancel(blackFriday())).toBe("open");
    expect(topCancel(tree({ tasks: [task(CAMPAIGN, { state: "cancelling" })] }))).toBe("cancelling");
    expect(topCancel(tree({ tasks: [task(CAMPAIGN, { state: "cancelled" })] }))).toBe("ended");
  });

  it("counts a retry as a new Attempt of the same Task", () => {
    const retried = tree({
      tasks: [task(CAMPAIGN, { ownerId: ALDRIC })],
      attempts: [
        attempt(CAMPAIGN, "failed"),
        new Attempt({ ...attempt(CAMPAIGN, "running"), id: AttemptId.make("a-retry"), number: 2 }),
      ],
    });
    expect(attemptCount(retried, nth(retried.tasks, 0))).toBe(2);
    expect(attemptCount(blackFriday(), nth(blackFriday().tasks, 1))).toBe(0);
  });
});

describe("parsePins", () => {
  it("keeps only ids, each once, and drops anything else stored under the key", () => {
    expect(parsePins(["campaign", "campaign", 3, "", "copy"])).toEqual([CAMPAIGN, COPY]);
    expect(parsePins({ not: "a list" })).toEqual([]);
    expect(parsePins(null)).toEqual([]);
  });
});

describe("sortPinnedReads", () => {
  it("offers Unpin only when the hub says the Task is gone, and keeps the pin when a read just failed", () => {
    const shown = { data: { tree: blackFriday() }, error: null, isError: false, refetch: () => undefined };
    const gone = { error: new ApiError("TaskNotFound", "TaskNotFound"), isError: true, refetch: () => undefined };
    const down = { error: new ApiError("Failed to fetch", undefined), isError: true, refetch: () => undefined };
    const stale = { ...shown, error: down.error, isError: true };
    const ids = [CAMPAIGN, COPY, BUILD, RESEARCH];
    const sorted = sortPinnedReads(ids, [shown, gone, down, stale]);
    expect(sorted.elsewhere).toHaveLength(2);
    expect(sorted.missing).toEqual([COPY]);
    expect(sorted.failed.map((each) => each.taskId)).toEqual([BUILD]);
  });
});

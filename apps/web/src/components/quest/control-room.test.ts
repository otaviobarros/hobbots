import { AgentId, Attempt, AttemptId, Quest, QuestId, type Task, TaskId, TaskWait } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  attempt,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  QUILL,
  quest,
  question,
  task,
  tree,
} from "../../test/quests.ts";
import { attemptCount, roomRows, taskControls, topCancel } from "./control-room.ts";
import { parsePins } from "./use-work.ts";

const ROOK = AgentId.make("rook");

/** The Task at `index` in the tree, which the test knows is there. */
const nth = (tasks: ReadonlyArray<Task>, index: number): Task => {
  const found = tasks[index];
  if (found === undefined) throw new Error(`No Task at ${index}`);
  return found;
};
const RESEARCH = TaskId.make("research");

/** Ada leads a Quest of her own under Aldric's: Rook researches keywords for her. */
const nested = () => {
  const base = blackFriday();
  return tree({
    ...base,
    tasks: [...base.tasks, task(RESEARCH, { ownerId: ROOK, parentId: BUILD, brief: "Research keywords", second: 4 })],
    quests: [
      ...base.quests,
      new Quest({ ...quest(), id: QuestId.make("quest-build"), taskId: BUILD, leadId: ADA, depth: 2 }),
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
  });

  it("says who each Task waits on: the hobs it depends on and whoever holds its question", () => {
    const base = blackFriday();
    const asking = tree({
      ...base,
      questions: [question(BUILD, ADA, "Dec 12 for international?", { recipientId: null })],
      waits: [
        new TaskWait({ taskId: CAMPAIGN, on: [COPY, BUILD], mode: "all", createdAt: nth(base.tasks, 0).createdAt }),
      ],
    });
    const rows = roomRows(asking);
    expect(rows.find((row) => row.task.id === BUILD)?.waitingOn).toEqual([{ kind: "hob", id: QUILL }, { kind: "you" }]);
    expect(rows.find((row) => row.task.id === CAMPAIGN)?.waitingOn).toEqual([
      { kind: "hob", id: QUILL },
      { kind: "hob", id: ADA },
    ]);
    expect(rows.find((row) => row.task.id === COPY)?.waitingOn).toEqual([]);
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

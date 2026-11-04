import { Attempt, AttemptId, Checkpoint, type Task, TaskId, type TaskTree } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  attempt,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  checkpoint,
  QUILL,
  question,
  task,
  tree,
} from "../../test/quests.ts";
import { failureReason, laneFailures, laneMenu, laneQuestions, laneTries } from "./lane-actions-model.ts";

const find = (from: TaskTree, id: Task["id"]): Task => {
  const found = from.tasks.find((each) => each.id === id);
  if (found === undefined) throw new Error(`No Task ${id}`);
  return found;
};

/** Black Friday with Quill's copy failed, as the hub records a failed Task. */
const copyFailed = (fields: Partial<ConstructorParameters<typeof TaskTree>[0]> = {}): TaskTree => {
  const base = blackFriday();
  return tree({
    ...base,
    tasks: base.tasks.map((each) =>
      each.id === COPY ? task(COPY, { ownerId: QUILL, state: "failed", second: 2 }) : each,
    ),
    ...fields,
  });
};

const nth = (taskId: Task["id"], number: number, state: Attempt["state"], outcome: string | null = null) =>
  new Attempt({ ...attempt(taskId, state), id: AttemptId.make(`a-${taskId}-${number}`), number, outcome });

describe("laneMenu", () => {
  it("offers the lead's lane Pin quest and Cancel quest… while the Quest runs, and nothing it cannot do", () => {
    const bf = blackFriday();
    expect(laneMenu(bf, find(bf, CAMPAIGN))).toEqual({
      retry: false,
      reassign: false,
      cancel: [],
      pin: true,
      cancelTop: "quest",
    });
  });

  it("calls the lead's cancel Cancel task while no party joined, and drops it once the request ended", () => {
    const alone = tree();
    expect(laneMenu(alone, find(alone, CAMPAIGN)).cancelTop).toBe("task");
    const ended = tree({ tasks: [task(CAMPAIGN, { state: "completed" })] });
    expect(laneMenu(ended, find(ended, CAMPAIGN)).cancelTop).toBeNull();
  });

  it("offers Retry only on a failed member's Task, and Reassign and Cancel where the hub accepts them", () => {
    const bf = blackFriday();
    const build = laneMenu(bf, find(bf, BUILD));
    expect(build).toMatchObject({ retry: false, reassign: true, pin: false });
    expect(build.cancel.map((each) => each.id)).toEqual([BUILD]);
    const failed = copyFailed();
    // A failed Task has ended: it can run again or change hands, and there is nothing left to cancel.
    expect(laneMenu(failed, find(failed, COPY))).toMatchObject({ retry: true, reassign: true, cancel: [] });
  });

  it("lets Cancel task… stop any of the hob's open Tasks and steps, the header's first, never the top Task", () => {
    const base = blackFriday();
    const STEP = TaskId.make("step");
    const LATER = TaskId.make("later");
    const busy = tree({
      ...base,
      tasks: [
        ...base.tasks,
        task(STEP, { ownerId: ALDRIC, brief: "Tidy the notes", second: 4 }),
        task(LATER, { ownerId: ADA, brief: "Send the recap", second: 5 }),
      ],
    });
    expect(laneMenu(busy, find(busy, LATER)).cancel.map((each) => each.id)).toEqual([LATER, BUILD]);
    // The lead's step can stop alone; the request itself is Cancel quest….
    const lead = laneMenu(busy, find(busy, CAMPAIGN));
    expect(lead.cancel.map((each) => each.id)).toEqual([STEP]);
    expect(lead.cancelTop).toBe("quest");
  });
});

describe("laneTries", () => {
  it("shows no picker while the Task has had one try", () => {
    const one = copyFailed({ attempts: [nth(COPY, 1, "failed")] });
    expect(laneTries(one, find(one, COPY), undefined)).toEqual([]);
  });

  it("lists each try first to last, marks the ones that failed, and shows the latest unless one is picked", () => {
    const first = nth(COPY, 1, "failed");
    const second = nth(COPY, 2, "running");
    const two = tree({ ...blackFriday(), attempts: [second, first] });
    const copy = find(two, COPY);
    expect(laneTries(two, copy, undefined).map((each) => [each.attempt.number, each.failed, each.picked])).toEqual([
      [1, true, false],
      [2, false, true],
    ]);
    expect(laneTries(two, copy, first.id).map((each) => each.picked)).toEqual([true, false]);
    // A try of another Task does not pick one here.
    expect(laneTries(two, copy, AttemptId.make("a-build-1")).map((each) => each.picked)).toEqual([false, true]);
  });
});

describe("laneQuestions", () => {
  it("lists the questions waiting for you on the lane's Tasks, not one a lead still holds", () => {
    const base = blackFriday();
    const asked = tree({
      ...base,
      questions: [question(BUILD, ADA, "Ship on Dec 12?", { recipientId: null, chain: [] })],
    });
    expect(laneQuestions(asked, [find(asked, BUILD)]).map((each) => each.question.text)).toEqual(["Ship on Dec 12?"]);
    const held = tree({ ...base, questions: [question(BUILD, ADA, "Ship on Dec 12?")] });
    expect(laneQuestions(held, [find(held, BUILD)])).toEqual([]);
  });
});

describe("laneFailures", () => {
  it("says why a failed Task stopped: the failure its hob reported first, else how its last try ended", () => {
    const reported = copyFailed({
      checkpoints: [checkpoint(COPY, "failed", "The template emails/base.mjml is missing.", 5)],
      attempts: [nth(COPY, 1, "failed", "exit 1")],
    });
    expect(failureReason(reported, find(reported, COPY))).toBe("The template emails/base.mjml is missing.");
    const ended = copyFailed({ attempts: [nth(COPY, 1, "failed", "first"), nth(COPY, 2, "failed", "second")] });
    expect(failureReason(ended, find(ended, COPY))).toBe("second");
    // The hub's checkpoint for the move to failed names only the state, so the Attempt says why.
    const moved = copyFailed({
      checkpoints: [new Checkpoint({ ...checkpoint(COPY, "failed", "failed", 6), source: "automatic" })],
      attempts: [nth(COPY, 1, "failed", "The image service timed out.")],
    });
    expect(failureReason(moved, find(moved, COPY))).toBe("The image service timed out.");
    const silent = copyFailed();
    expect(failureReason(silent, find(silent, COPY))).toBeNull();
  });

  it("lists only the lane's failed Tasks, each with Retry and Reassign where they apply", () => {
    const failed = copyFailed();
    expect(laneFailures(failed, [find(failed, BUILD)])).toEqual([]);
    expect(laneFailures(failed, [find(failed, COPY)]).map((each) => [each.task.id, each.retry, each.reassign])).toEqual(
      [[COPY, true, true]],
    );
  });
});

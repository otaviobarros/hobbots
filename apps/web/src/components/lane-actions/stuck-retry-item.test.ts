import { BackpackItem, BackpackItemId, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { blackFriday, COPY, QUILL, stuckItem, THREAD, task, tree } from "../../test/quests.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { stuckRetries } from "./stuck-retry-item.tsx";

const hobs: HobLookup = () => ({ name: "Quill", lookSeed: 1, lookColor: "moss" });
const LATER = TaskId.make("copy-later");

/** Quill holds two Tasks on the Quest: the header's, and one created after it. */
const twoTasks = () => {
  const base = blackFriday();
  return tree({
    ...base,
    tasks: [...base.tasks, task(LATER, { ownerId: QUILL, brief: "Polish the copy", second: 9 })],
  });
};

const stuckOn = (taskId: TaskId, id = `stuck-${taskId}`) =>
  new BackpackItem({ ...stuckItem(THREAD), id: BackpackItemId.make(id), taskId });

describe("Retry on a lane's stuck work", () => {
  it("offers Retry for stuck work on any of the hob's unfinished Tasks, the header's first (#1087)", () => {
    const lane = twoTasks();
    const header = lane.tasks.find((each) => each.id === COPY);
    if (header === undefined) throw new Error("no header Task");
    expect(stuckRetries(lane, header, [stuckOn(LATER)], hobs).map((each) => each.task.id)).toEqual([LATER]);
    expect(stuckRetries(lane, header, [stuckOn(LATER), stuckOn(COPY)], hobs).map((each) => each.task.id)).toEqual([
      COPY,
      LATER,
    ]);
    // A retired hob's work is dismissed, never retried, and nothing about other hobs' Tasks shows.
    expect(stuckRetries(lane, header, [stuckItem(THREAD, true)], hobs)).toEqual([]);
    expect(stuckRetries(lane, header, [stuckOn(TaskId.make("build"))], hobs)).toEqual([]);
  });
});

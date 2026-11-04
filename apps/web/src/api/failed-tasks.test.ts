import type { FailedTask, Task } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { failedTaskChanged, failedTasksQuery } from "./failed-tasks.ts";

// Only ids and states matter here: each read answers with what the hub had when it was taken.
const failed = (id: string, rootId = "launch") => ({ task: { id, rootId }, leadId: null }) as unknown as FailedTask;
const task = (id: string, state: Task["state"], rootId = "launch") => ({ id, rootId, state }) as unknown as Task;

/** The failed Tasks on screen, whose reads answer only when the test says so. */
const watchedList = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: ReadonlyArray<FailedTask>) => void> = [];
  const observer = new QueryObserver(client, {
    ...failedTasksQuery,
    queryFn: () => new Promise<ReadonlyArray<FailedTask>>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const answer = (n: number, value: ReadonlyArray<FailedTask>) => pending[n]?.(value);
  const shown = () => observer.getCurrentResult().data?.map((each) => each.task.id);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, answer, shown, settled, reads: () => pending.length, unsubscribe };
};

describe("failedTaskChanged", () => {
  // covers IN-004, OR-006
  it("[TC-UX-194] drops a first read taken before the failed Task was retried, so no mark is left", async () => {
    const list = watchedList();
    await list.settled();
    const changed = failedTaskChanged(list.client, task("copy", "queued"));
    await list.settled();
    expect(list.reads()).toBe(2);
    list.answer(1, []);
    list.answer(0, [failed("copy")]);
    await changed;
    await list.settled();
    expect(list.shown()).toEqual([]);
    list.unsubscribe();
  });

  it("reads nothing again when a Task it does not hold moves on and no read is on its way", async () => {
    const list = watchedList();
    list.answer(0, [failed("copy")]);
    await list.settled();
    await failedTaskChanged(list.client, task("other", "completed", "elsewhere"));
    expect(list.reads()).toBe(1);
    list.unsubscribe();
  });
});

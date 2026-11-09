import type { TaskTreeRead, ThreadTasksRead } from "@hobbots/api";
import { Attempt } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attempt, BUILD, blackFriday, CAMPAIGN, COPY, QUILL, THREAD, task, tree } from "../test/quests.ts";
import * as client from "./client.ts";
import { startGeneration } from "./sync.ts";
import { applyTaskEvent, taskKeys, threadTasksQuery } from "./tasks.ts";

afterEach(() => vi.restoreAllMocks());

const read = (trees = [tree()]): ThreadTasksRead => ({ cursor: "1:1", trees });

/** A read the test answers when it chooses, as a slow network would. */
const slowRead = () => {
  let answer: (value: ThreadTasksRead) => void = () => undefined;
  vi.spyOn(client, "call").mockReturnValue(
    new Promise((done) => {
      answer = done as typeof answer;
    }) as never,
  );
  return (value: ThreadTasksRead) => answer(value);
};

describe("Task reads kept live", () => {
  // covers OR-007
  it("[TC-OR-011] applies an event that arrived while a thread's read was on its way", async () => {
    const queryClient = new QueryClient();
    const answer = slowRead();
    const loading = queryClient.fetchQuery(threadTasksQuery(THREAD));
    applyTaskEvent(queryClient, {
      _tag: "TaskCreated",
      task: task(COPY, { ownerId: QUILL }),
      delegation: null,
      milestones: [],
    });
    answer(read());
    const loaded = await loading;
    expect(loaded.trees[0]?.tasks.map((each) => each.id)).toEqual(["campaign", COPY]);
  });

  it("patches every cached read the event belongs to and leaves the rest", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(taskKeys.thread(THREAD), read([blackFriday()]));
    queryClient.setQueryData(["tasks", "elsewhere"], { untouched: true });
    applyTaskEvent(queryClient, {
      _tag: "TaskStateChanged",
      task: task(BUILD, { state: "active", revision: 4 }),
      attempt: null,
      quest: null,
      wait: null,
    });
    const thread = queryClient.getQueryData<ThreadTasksRead>(taskKeys.thread(THREAD));
    expect(thread?.trees[0]?.tasks.find((each) => each.id === BUILD)?.state).toBe("active");
    expect(queryClient.getQueryData(["tasks", "elsewhere"])).toEqual({ untouched: true });
  });

  it("keeps a single tree read live too, such as a Quest pinned from another thread", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<TaskTreeRead>(taskKeys.tree(CAMPAIGN), { cursor: "1:1", tree: blackFriday() });
    applyTaskEvent(queryClient, {
      _tag: "TaskStateChanged",
      task: task(COPY, { ownerId: QUILL, state: "failed", revision: 4 }),
      attempt: null,
      quest: null,
      wait: null,
    });
    const pinned = queryClient.getQueryData<TaskTreeRead>(taskKeys.tree(CAMPAIGN));
    expect(pinned?.tree.tasks.find((each) => each.id === COPY)?.state).toBe("failed");
  });

  // covers ADR 036 (The read-the-web mark), UX-006
  it("[TC-UX-1268-02] shows an Attempt's read-the-web mark as it changes, keeping the state the tree knows", () => {
    const queryClient = new QueryClient();
    const running = attempt(COPY, "running");
    queryClient.setQueryData<TaskTreeRead>(taskKeys.tree(CAMPAIGN), {
      cursor: "1:1",
      tree: { ...blackFriday(), attempts: [running] },
    });
    const readWeb = { since: "2026-11-09T10:00:00.000Z", source: "https://lamps.test/page" };
    // An older copy of the Attempt, still starting, carries the mark.
    applyTaskEvent(queryClient, {
      _tag: "AttemptReadWeb",
      taskId: COPY,
      attempt: new Attempt({ ...running, state: "starting", readWeb }),
    });
    const marked = queryClient.getQueryData<TaskTreeRead>(taskKeys.tree(CAMPAIGN))?.tree.attempts[0];
    expect(marked).toMatchObject({ id: running.id, state: "running", readWeb });
  });

  it("reads again when a new sync generation began while the read was on its way", async () => {
    const queryClient = new QueryClient();
    const call = vi
      .spyOn(client, "call")
      .mockImplementationOnce(async () => {
        startGeneration(queryClient);
        return read();
      })
      .mockResolvedValueOnce(read([blackFriday()]));
    const loaded = await queryClient.fetchQuery(threadTasksQuery(THREAD));
    expect(call).toHaveBeenCalledTimes(2);
    expect(loaded.trees[0]?.tasks).toHaveLength(3);
  });
});

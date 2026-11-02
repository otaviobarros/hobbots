import type { TaskTreeRead, ThreadTasksRead } from "@hobbots/api";
import type { TaskId, ThreadId } from "@hobbots/domain";
import { type QueryClient, type QueryFunctionContext, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";
import { syncState } from "./sync.ts";
import { applyToThreadTrees, applyToTree, type TaskEvent } from "./task-trees.ts";

/**
 * Task reads (ADR 018), kept live by the journal. A read can land after an event it does
 * not show yet, so the events that arrive while reads are on their way are kept and applied on top.
 * Any event that arrived before a read started was committed before the hub read it, so once no read
 * is on its way the kept events are dropped.
 */
export const taskKeys = {
  all: ["tasks"] as const,
  thread: (threadId: ThreadId) => ["tasks", "thread", threadId] as const,
  tree: (taskId: TaskId) => ["tasks", "tree", taskId] as const,
};

interface Replay {
  generation: number;
  /** Reads on their way in this generation. */
  pending: number;
  events: Array<TaskEvent>;
}

const replays = new WeakMap<QueryClient, Replay>();

/** The Task events kept for reads on their way, in order; a new generation starts empty. */
const replayOf = (client: QueryClient): Replay => {
  const generation = syncState(client).generation;
  let replay = replays.get(client);
  if (replay === undefined || replay.generation !== generation) {
    replay = { generation, pending: 0, events: [] };
    replays.set(client, replay);
  }
  return replay;
};

/**
 * Wraps a read so it belongs to the current generation: one that lands after a new generation
 * began is read again, and the generation's events are applied on top of it.
 */
const synced =
  <A>(fetch: () => Promise<A>, apply: (read: A, event: TaskEvent) => A) =>
  async ({ client }: QueryFunctionContext): Promise<A> => {
    for (;;) {
      const started = replayOf(client);
      started.pending += 1;
      const read = await fetch().finally(() => {
        started.pending -= 1;
      });
      if (replayOf(client) !== started) continue;
      const applied = started.events.reduce(apply, read);
      if (started.pending === 0) started.events.length = 0;
      return applied;
    }
  };

const applyToThread =
  (threadId: ThreadId) =>
  (read: ThreadTasksRead, event: TaskEvent): ThreadTasksRead => {
    const trees = applyToThreadTrees(threadId, read.trees, event);
    return trees === read.trees ? read : { ...read, trees };
  };

/** The Tasks a thread's requests started, each with everything under it. */
export const threadTasksQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: taskKeys.thread(threadId),
    queryFn: synced(() => call((c) => c.tasks.threadTasks({ params: { threadId } })), applyToThread(threadId)),
  });

const applyToTreeRead = (read: TaskTreeRead, event: TaskEvent): TaskTreeRead => {
  const tree = applyToTree(read.tree, event);
  return tree === read.tree ? read : { ...read, tree };
};

/** A Task and everything under it, such as a Quest pinned from another thread. */
export const taskTreeQuery = (taskId: TaskId) =>
  queryOptions({
    queryKey: taskKeys.tree(taskId),
    queryFn: synced(() => call((c) => c.tasks.tree({ params: { taskId } })), applyToTreeRead),
  });

/**
 * Applies a Task event to every cached Task read and keeps it for reads still on their way. Reads
 * not loaded yet are left alone; they get the event when they land.
 */
export const applyTaskEvent = (client: QueryClient, event: TaskEvent) => {
  const replay = replayOf(client);
  if (replay.pending > 0) replay.events.push(event);
  for (const [queryKey, read] of client.getQueriesData<unknown>({ queryKey: taskKeys.all })) {
    if (read === undefined) continue;
    const next = applyToRead(queryKey, read, event);
    if (next !== read) client.setQueryData(queryKey, next);
  }
};

const applyToRead = (queryKey: ReadonlyArray<unknown>, read: unknown, event: TaskEvent): unknown => {
  const [, kind, id] = queryKey;
  if (kind === "thread") return applyToThread(id as ThreadId)(read as ThreadTasksRead, event);
  return kind === "tree" ? applyToTreeRead(read as TaskTreeRead, event) : read;
};

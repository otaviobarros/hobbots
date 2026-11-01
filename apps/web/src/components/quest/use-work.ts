import type { Agent, AgentId, TaskId, TaskTree, ThreadId } from "@hobbots/domain";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
import { agentsQuery } from "../../api/queries.ts";
import { taskTreeQuery, threadTasksQuery } from "../../api/tasks.ts";
import { readStored, writeStored } from "../../lib/storage.ts";
import { messages } from "./messages.ts";

/** The trees of the Tasks this thread's requests started, empty while they load. */
export const useThreadTrees = (threadId: ThreadId | undefined) =>
  useQuery({
    ...threadTasksQuery(threadId ?? ("" as ThreadId)),
    enabled: threadId !== undefined,
    select: (read) => read.trees,
  }).data ?? [];

export type HobLookup = (
  id: AgentId,
) => Pick<Agent, "name" | "lookSeed" | "lookColor"> & Partial<Pick<Agent, "hat" | "tool" | "sigil">>;

const unknownHob = { name: messages.someHob, lookSeed: 0, lookColor: "violet" } as const;

/** Every hob by id, with a stand-in for one this client does not know. */
export const useHobLookup = (): HobLookup => {
  const hobs = useQuery(agentsQuery).data ?? [];
  return (id) => hobs.find((hob) => hob.id === id) ?? unknownHob;
};

/** Opens a Task in the drawer beside the chat, or closes the drawer, through the address. */
export const useOpenTask = (hobId: AgentId, threadId: ThreadId) => {
  const navigate = useNavigate();
  return (taskId: TaskId | undefined) =>
    void navigate({
      to: "/hobs/$hobId/threads/$threadId",
      params: { hobId, threadId },
      search: taskId === undefined ? {} : { task: taskId },
    });
};

const PINS_KEY = "quest.pinned";

/** The hub answered that it has no such Task, as opposed to a read that failed on the way. */
const isTaskNotFound = (error: unknown): boolean => error instanceof ApiError && error.tag === "TaskNotFound";

/** The top Tasks you pinned, kept on this device, so their Quests stay in view in every thread. */
export interface Pins {
  readonly pinned: ReadonlyArray<TaskId>;
  readonly toggle: (taskId: TaskId) => void;
}

/** The stored pins, kept only when they are a list of ids, each once. */
export const parsePins = (stored: unknown): ReadonlyArray<TaskId> =>
  Array.isArray(stored)
    ? [...new Set(stored.filter((id): id is string => typeof id === "string" && id !== ""))].map((id) => id as TaskId)
    : [];

export const usePins = (): Pins => {
  const [pinned, setPinned] = useState<ReadonlyArray<TaskId>>(() => parsePins(readStored<unknown>(PINS_KEY, [])));
  const toggle = (taskId: TaskId) => {
    const next = pinned.includes(taskId) ? pinned.filter((id) => id !== taskId) : [...pinned, taskId];
    writeStored(PINS_KEY, next);
    setPinned(next);
  };
  return { pinned, toggle };
};

interface PinnedRead {
  readonly data?: { readonly tree: TaskTree } | undefined;
  readonly error: unknown;
  readonly isError: boolean;
  readonly refetch: () => unknown;
}

/**
 * Sorts the reads of pinned Tasks: trees to show, Tasks the hub says it no longer has, and reads
 * that failed otherwise, which keep their pin and can be read again.
 */
export const sortPinnedReads = (taskIds: ReadonlyArray<TaskId>, results: ReadonlyArray<PinnedRead>) => {
  const read = results.map((result, index) => ({ result, taskId: taskIds[index] as TaskId }));
  return {
    elsewhere: read.flatMap(({ result }) =>
      result.data === undefined || isTaskNotFound(result.error) ? [] : [result.data.tree],
    ),
    missing: read.filter(({ result }) => isTaskNotFound(result.error)).map(({ taskId }) => taskId),
    failed: read
      .filter(({ result }) => result.isError && result.data === undefined && !isTaskNotFound(result.error))
      .map(({ result, taskId }) => ({ taskId, retry: () => void result.refetch() })),
  };
};

/**
 * The trees a thread follows: the Tasks its own requests started, and the pinned ones that started
 * elsewhere, in the order they were pinned. Pins are read once the thread's own trees are known, so
 * its own pinned tree never shows as from elsewhere. A pinned Task the hub says it no longer has is
 * listed in `missing`, so it can be unpinned; one whose read failed otherwise is in `failed`, kept
 * pinned, with a way to read it again.
 */
export const useFollowedTrees = (threadId: ThreadId | undefined, pinned: ReadonlyArray<TaskId>) => {
  const read = useQuery({
    ...threadTasksQuery(threadId ?? ("" as ThreadId)),
    enabled: threadId !== undefined,
    select: (each) => each.trees,
  });
  const thread = read.data ?? [];
  const known = threadId === undefined || read.isSuccess;
  const others = known ? pinned.filter((id) => !thread.some((tree) => tree.tasks[0]?.id === id)) : [];
  const { elsewhere, missing, failed } = useQueries({
    queries: others.map((taskId) => ({
      ...taskTreeQuery(taskId),
      retry: (count: number, error: Error) => !isTaskNotFound(error) && count < 3,
    })),
    combine: (results) => sortPinnedReads(others, results),
  });
  return { thread, elsewhere, missing, failed };
};

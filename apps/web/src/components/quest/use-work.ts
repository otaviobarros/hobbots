import type { Agent, AgentId, TaskId, TaskTree, ThreadId } from "@hobbots/domain";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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

/** The top Tasks you pinned, kept on this device, so their Quests stay in view in every thread. */
export interface Pins {
  readonly pinned: ReadonlyArray<TaskId>;
  readonly toggle: (taskId: TaskId) => void;
}

export const usePins = (): Pins => {
  const [pinned, setPinned] = useState<ReadonlyArray<TaskId>>(() => readStored<Array<TaskId>>(PINS_KEY, []));
  const toggle = (taskId: TaskId) => {
    const next = pinned.includes(taskId) ? pinned.filter((id) => id !== taskId) : [...pinned, taskId];
    writeStored(PINS_KEY, next);
    setPinned(next);
  };
  return { pinned, toggle };
};

/**
 * The trees a thread follows: the Tasks its own requests started, and the pinned ones that started
 * elsewhere, in the order they were pinned. A pinned Task the hub no longer has is left out.
 */
export const useFollowedTrees = (threadId: ThreadId | undefined, pinned: ReadonlyArray<TaskId>) => {
  const thread = useThreadTrees(threadId);
  const others = pinned.filter((id) => !thread.some((tree) => tree.tasks[0]?.id === id));
  const elsewhere = useQueries({
    queries: others.map((taskId) => ({ ...taskTreeQuery(taskId), select: (read: { tree: TaskTree }) => read.tree })),
    combine: (results) => results.flatMap((result) => (result.data === undefined ? [] : [result.data])),
  });
  return { thread, elsewhere };
};

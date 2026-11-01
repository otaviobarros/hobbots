import type { Agent, AgentId, TaskId, ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { agentsQuery } from "../../api/queries.ts";
import { threadTasksQuery } from "../../api/tasks.ts";
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

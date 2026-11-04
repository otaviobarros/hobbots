import type { Agent, AgentId, ApprovalRequest, DeviceId, Quest, TaskId, ThreadId } from "@hobbots/domain";
import { useQueries, useQuery } from "@tanstack/react-query";
import { devicesQuery } from "../../api/devices.ts";
import { agentsQuery, archivedAgentsQuery, threadsQuery } from "../../api/queries.ts";
import { threadTasksQuery } from "../../api/tasks.ts";
import { entryThread, type InboxEntry, topQuests } from "./inbox-entries.ts";
import { messages } from "./messages.ts";

export interface InboxDirectory {
  /** The hob that asked, retired hobs included; undefined while the hobs load. */
  readonly hob: (agentId: AgentId) => Agent | undefined;
  readonly hobName: (agentId: AgentId) => string;
  readonly threadTitle: (threadId: ThreadId) => string;
  /**
   * The hob whose chat the thread is, which is the asker's own except for a party member's request:
   * that one asks in its lead's thread (ADR 018). Undefined while the threads load.
   */
  readonly threadHob: (threadId: ThreadId) => AgentId | undefined;
  /** The name of the device a request was decided from, revoked devices included (#598). */
  readonly deviceName: (deviceId: DeviceId) => string;
}

/**
 * Who asked each request and in which thread, read from the hob and thread lists the app already
 * keeps live. A party member asks in its lead's thread, so every hob's threads are read.
 */
export const useInboxDirectory = (approvals: ReadonlyArray<ApprovalRequest>): InboxDirectory => {
  const active = useQuery(agentsQuery);
  const retired = useQuery(archivedAgentsQuery);
  const hobs = new Map([...(retired.data ?? []), ...(active.data ?? [])].map((hob) => [hob.id, hob]));
  const askers = new Set(approvals.map((approval) => approval.agentId));
  const owners = Array.from(new Set([...askers, ...(active.data ?? []).map((hob) => hob.id)]));
  const threadLists = useQueries({ queries: owners.map((agentId) => threadsQuery(agentId)) });
  const devices = useQuery(devicesQuery);
  const deviceNames = new Map((devices.data ?? []).map((device) => [device.id, device.name]));
  const threads = new Map(threadLists.flatMap((list) => (list.data ?? []).map((thread) => [thread.id, thread])));
  return {
    hob: (agentId) => hobs.get(agentId),
    hobName: (agentId) => hobs.get(agentId)?.name ?? messages.unknownHob,
    threadTitle: (threadId) => threads.get(threadId)?.title || messages.untitledThread,
    threadHob: (threadId) => threads.get(threadId)?.agentId,
    deviceName: (deviceId) => deviceNames.get(deviceId) ?? messages.unknownDevice,
  };
};

/**
 * The top Quest over each Task the entries are about, read from the Task trees of their threads,
 * which the journal keeps live. A Task not read yet has none, so its entry waits under its thread.
 */
export const useEntryQuests = (entries: ReadonlyArray<InboxEntry>): ((taskId: TaskId) => Quest | undefined) => {
  const threads = Array.from(new Set(entries.map(entryThread).filter((threadId) => threadId !== null)));
  const trees = useQueries({
    queries: threads.map((threadId) => threadTasksQuery(threadId)),
    combine: (results) => results.flatMap((result) => result.data?.trees ?? []),
  });
  const quests = topQuests(trees);
  return (taskId) => quests.get(taskId);
};

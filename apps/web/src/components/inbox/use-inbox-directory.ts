import type { Agent, AgentId, ApprovalRequest, DeviceId, Quest, TaskId, ChannelId } from "@hobbots/domain";
import { useQueries, useQuery } from "@tanstack/react-query";
import { devicesQuery } from "../../api/devices.ts";
import { agentsQuery, archivedAgentsQuery, channelsQuery } from "../../api/queries.ts";
import { channelTasksQuery } from "../../api/tasks.ts";
import { entryChannel, type InboxEntry, topQuests } from "./inbox-entries.ts";
import { messages } from "./messages.ts";

export interface InboxDirectory {
  /** The hob that asked, retired hobs included; undefined while the hobs load. */
  readonly hob: (agentId: AgentId) => Agent | undefined;
  readonly hobName: (agentId: AgentId) => string;
  readonly channelTitle: (channelId: ChannelId) => string;
  /**
   * The hob whose chat the channel is, which is the asker's own except for a party member's request:
   * that one asks in its lead's channel (ADR 018). Undefined while the channels load.
   */
  readonly channelHob: (channelId: ChannelId) => AgentId | undefined;
  /** The name of the device a request was decided from, revoked devices included (#598). */
  readonly deviceName: (deviceId: DeviceId) => string;
}

/**
 * Who asked each request and in which channel, read from the hob and channel lists the app already
 * keeps live. A party member asks in its lead's channel, so every hob's channels are read.
 */
export const useInboxDirectory = (approvals: ReadonlyArray<ApprovalRequest>): InboxDirectory => {
  const active = useQuery(agentsQuery);
  const retired = useQuery(archivedAgentsQuery);
  const hobs = new Map([...(retired.data ?? []), ...(active.data ?? [])].map((hob) => [hob.id, hob]));
  const askers = new Set(approvals.map((approval) => approval.agentId));
  const owners = Array.from(new Set([...askers, ...(active.data ?? []).map((hob) => hob.id)]));
  const channelLists = useQueries({ queries: owners.map((agentId) => channelsQuery(agentId)) });
  const devices = useQuery(devicesQuery);
  const deviceNames = new Map((devices.data ?? []).map((device) => [device.id, device.name]));
  const channels = new Map(channelLists.flatMap((list) => (list.data ?? []).map((channel) => [channel.id, channel])));
  return {
    hob: (agentId) => hobs.get(agentId),
    hobName: (agentId) => hobs.get(agentId)?.name ?? messages.unknownHob,
    channelTitle: (channelId) => channels.get(channelId)?.title || messages.untitledChannel,
    channelHob: (channelId) => channels.get(channelId)?.agentId,
    deviceName: (deviceId) => deviceNames.get(deviceId) ?? messages.unknownDevice,
  };
};

/**
 * The top Quest over each Task the entries are about, read from the Task trees of their channels,
 * which the journal keeps live. A Task not read yet has none, so its entry waits under its channel.
 */
export const useEntryQuests = (entries: ReadonlyArray<InboxEntry>): ((taskId: TaskId) => Quest | undefined) => {
  const channels = Array.from(new Set(entries.map(entryChannel).filter((channelId) => channelId !== null)));
  const trees = useQueries({
    queries: channels.map((channelId) => channelTasksQuery(channelId)),
    combine: (results) => results.flatMap((result) => result.data?.trees ?? []),
  });
  const quests = topQuests(trees);
  return (taskId) => quests.get(taskId);
};

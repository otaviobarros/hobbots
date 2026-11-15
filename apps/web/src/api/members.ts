import type { MembersReport } from "@hobbots/api";
import type { Actor, HobbotsEvent, ChannelId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { localDay, periodStart } from "../lib/usage.ts";
import { call } from "./client.ts";
import { sidebarChanged } from "./sidebar.ts";

// A camp's members sheet (ADR 039, Members; Status and cost): who is in it and what its hobs spent
// there today, as the hub reads them, and adding a hob or taking one out.

const membersKey = (channelId: ChannelId) => ["channels", channelId, "members"] as const;

/**
 * The channel's members and each hob's turns and tokens there today, from the start of the reader's
 * own day. `today` keys the read to that day, so the numbers start again at midnight. Kept current
 * by the member events and by each reply that settles there.
 */
const membersQuery = (channelId: ChannelId, today: string) =>
  queryOptions({
    queryKey: [...membersKey(channelId), today] as const,
    queryFn: (): Promise<MembersReport> =>
      call((c) => c.members.list({ params: { channelId }, query: { since: periodStart(new Date(), 1).toISOString() } })),
    staleTime: 30_000,
  });

/** The members read for the reader's day now. */
export const membersToday = (channelId: ChannelId) => membersQuery(channelId, localDay(new Date()));

/** Someone joined or left the channel, or a reply there settled: its members are read again. */
const membersChanged = async (queryClient: QueryClient, channelId: ChannelId) => {
  // A read already in flight may predate the change, so it is cancelled first (STD-REACT-012).
  await queryClient.cancelQueries({ queryKey: membersKey(channelId) });
  await queryClient.invalidateQueries({ queryKey: membersKey(channelId) });
};

/**
 * The channels whose members sheets an event changes: a member's, that of a hob's reply that settled
 * or turn it passed, or both channels of a chapter that moved, whose replies count where they now are.
 */
const changedChannels = (event: HobbotsEvent): ReadonlyArray<ChannelId> => {
  if (event._tag === "ChapterMoved") return [event.channel.id, event.camp.id];
  const one = changedChannel(event);
  return one === null ? [] : [one];
};

const changedChannel = (event: HobbotsEvent): ChannelId | null => {
  if (event._tag === "ChannelMemberAdded" || event._tag === "ChannelMemberChanged") return event.member.channelId;
  // A passed turn leaves no reply, but what it used still counts here.
  if (event._tag === "TurnPassed") return event.channelId;
  // A reply counts once it settles: streaming updates change no total.
  if (event._tag === "MessageUpserted" && event.message.role === "assistant") {
    const status = event.message.status;
    return status === "streaming" || status === "stopping" || status === "queued" ? null : event.message.channelId;
  }
  return null;
};

/** Reads a members sheet again after an event that changes it; the event's own handling goes on. */
export const applyMembersEvent = (queryClient: QueryClient, event: HobbotsEvent) => {
  for (const channelId of changedChannels(event)) void membersChanged(queryClient, channelId);
};

/** Adds a hob to the camp, or brings back one taken out. */
export const useAddMember = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (actor: Actor) => call((c) => c.members.add({ params: { channelId }, payload: { actor } })),
    onSuccess: () => Promise.all([membersChanged(queryClient, channelId), sidebarChanged(queryClient)]),
  });
};

/** Takes a member out of the camp: a hob's answers still owed there are dropped with it. */
export const useRemoveMember = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (actor: Actor) =>
      call((c) => c.members.remove({ params: { channelId, kind: actor.kind, id: actor.id } })),
    onSuccess: () => Promise.all([membersChanged(queryClient, channelId), sidebarChanged(queryClient)]),
  });
};

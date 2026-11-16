import type { MakeCampPayload } from "@hobbots/api";
import { type AgentId, type Channel, type ChannelId, ChannelLifecycle, type Chapter } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { chaptersMoved } from "./chapters.ts";
import { call } from "./client.ts";
import { recordsMoved } from "./notes.ts";
import { placeChannel, queryKeys } from "./queries.ts";
import { questionsMoved } from "./questions.ts";
import { recordChannel, recordMovedMessages } from "./sync.ts";
import { channelTasksMoved } from "./tasks.ts";

// Make a camp and Start fresh (ADR 037). Both take a key the client makes, which becomes the new
// channel's id, so sending the same request again, as a retry after a lost answer does, changes nothing.

const carryOverKey = (channelId: ChannelId) => ["channels", channelId, "carryOver"] as const;

/**
 * What Start fresh would carry over from the chat now, read each time its sheet opens: no event says
 * when it changes, and the sheet is open only for a moment.
 */
export const carryOverQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: carryOverKey(channelId),
    queryFn: () => call((c) => c.channels.carryOver({ params: { channelId } })),
    staleTime: 0,
  });

/** The hob's open chat, the one the sidebar lists first and opening the hob opens, if it has one. */
export const openChatOf = (channels: ReadonlyArray<Channel> | undefined): Channel | undefined =>
  channels?.find(ChannelLifecycle.isOpenChat);

/**
 * The hob's camps, pinned first, the most recently pinned on top, then the rest in the order of its
 * channel list, by last activity.
 */
export const campsOf = (channels: ReadonlyArray<Channel> | undefined): ReadonlyArray<Channel> => {
  const camps = channels?.filter((channel) => channel.kind === "camp") ?? [];
  const pinned = camps
    .filter((camp) => camp.pinnedAt !== null)
    .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
  return [...pinned, ...camps.filter((camp) => camp.pinnedAt === null)];
};

const show = (queryClient: QueryClient, channel: Channel) => {
  recordChannel(queryClient, channel);
  placeChannel(queryClient, channel);
};

/**
 * A chat was started fresh, here or by its event: the old chat moves to the hob's archived channels
 * and the new one joins its list. The Tasks started there moved with it, so both chats read their
 * work again, and the questions waiting for you read again the chat each now belongs to.
 */
export const chatStartedFresh = (
  queryClient: QueryClient,
  { superseded, chat }: { readonly superseded: Channel; readonly chat: Channel },
) => {
  for (const channel of [superseded, chat]) {
    show(queryClient, channel);
    void channelTasksMoved(queryClient, channel.id);
  }
  // A read already on its way may predate the move, so it is cancelled first (STD-REACT-012).
  void questionsMoved(queryClient);
};

/**
 * A chapter moved into a camp (ADR 037): both channels take their new rows and chapters, and read
 * their transcripts and their work again, since messages and the quests started in the chapter
 * moved, as did the questions waiting in those quests, and the chapter's decisions, artifacts and pins.
 */
export const chapterMoved = async (
  queryClient: QueryClient,
  {
    channel,
    camp,
    stub,
    chapter,
    chapters,
    campChapters,
  }: {
    readonly channel: Channel;
    readonly camp: Channel;
    readonly stub: Chapter;
    readonly chapter: Chapter;
    readonly chapters: ReadonlyArray<Chapter>;
    readonly campChapters: ReadonlyArray<Chapter>;
  },
): Promise<void> => {
  // Messages an event brought this generation say where they are now, or a read would add them back.
  recordMovedMessages(queryClient, { stub, chapter });
  for (const each of [channel, camp]) show(queryClient, each);
  // A transcript read already on its way may predate the move, and messages it read before any event
  // brought them are in no overlay, so it is cancelled before both are read again (STD-REACT-012).
  await Promise.all(
    [channel, camp].map((each) => queryClient.cancelQueries({ queryKey: queryKeys.messages(each.id), exact: true })),
  );
  for (const each of [channel, camp]) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages(each.id), exact: true });
    void channelTasksMoved(queryClient, each.id);
  }
  void chaptersMoved(queryClient, [
    { channelId: channel.id, chapters },
    { channelId: camp.id, chapters: campChapters },
  ]);
  void questionsMoved(queryClient);
  void recordsMoved(queryClient, [channel.id, camp.id]);
};

/**
 * Makes a camp for the hob that leads it, with the other hobs picked; it joins the hob's list at once,
 * before its event arrives.
 */
export const useMakeCamp = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, payload }: { readonly agentId: AgentId; readonly payload: MakeCampPayload }) =>
      call((c) => c.agents.makeCamp({ params: { agentId }, payload })),
    onSuccess: (camp) => {
      // A new channel has no messages yet, so its transcript shows at once instead of loading.
      queryClient.setQueryData(queryKeys.messages(camp.id), (old: ReadonlyArray<unknown> | undefined) => old ?? []);
      show(queryClient, camp);
    },
  });
};

/**
 * Starts the hob's chat fresh: the old chat moves to the archived list and the new one takes its
 * place. The Tasks started there moved with it, so both chats read their work again.
 */
export const useStartFresh = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channel, key }: { channel: Channel; key: ChannelId }) =>
      call((c) => c.channels.startFresh({ params: { channelId: channel.id }, payload: { key } })),
    onSuccess: (started) => {
      chatStartedFresh(queryClient, started);
      void queryClient.invalidateQueries({ queryKey: carryOverKey(started.superseded.id), exact: true });
    },
  });
};

import { Channel } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { placeChannel, queryKeys } from "./queries.ts";
import { recordChannel } from "./sync.ts";

/**
 * Changes a channel in its hob's list at once, then sends the change. The channel the hub returns
 * takes its place; a failure puts the channel back as it was. Other clients hear of it from its event.
 */
const useChannelChange = <V>(
  send: (channel: Channel, value: V) => Promise<Channel>,
  apply: (channel: Channel, value: V) => Channel,
) => {
  const queryClient = useQueryClient();
  const swap = (next: Channel) =>
    queryClient.setQueryData<ReadonlyArray<Channel>>(queryKeys.channels(next.agentId), (old) =>
      old?.map((t) => (t.id === next.id ? next : t)),
    );
  return useMutation({
    mutationFn: ({ channel, value }: { channel: Channel; value: V }) => send(channel, value),
    onMutate: ({ channel, value }) => swap(apply(channel, value)),
    onError: (_, { channel }) => swap(channel),
    onSuccess: (changed) => {
      recordChannel(queryClient, changed);
      placeChannel(queryClient, changed);
    },
  });
};

/** Renames a channel to a title already trimmed and not empty. */
export const useRenameChannel = () =>
  useChannelChange<string>(
    (channel, title) => call((c) => c.channels.rename({ params: { channelId: channel.id }, payload: { title } })),
    (channel, title) => new Channel({ ...channel, title }),
  );

/** Pins a channel to the top of its hob's chats, or unpins it. */
export const usePinChannel = () =>
  useChannelChange<boolean>(
    (channel, pinned) => call((c) => c.channels.pin({ params: { channelId: channel.id }, payload: { pinned } })),
    (channel, pinned) => new Channel({ ...channel, pinnedAt: pinned ? new Date().toISOString() : null }),
  );

/**
 * Makes a camp private, or not, from now on (ADR 037): what memory captured before stays. A chat has
 * no such setting.
 */
export const useSetCampPrivate = () =>
  useChannelChange<boolean>(
    (channel, value) =>
      call((c) => c.channels.setPrivate({ params: { channelId: channel.id }, payload: { private: value } })),
    (channel, value) => new Channel({ ...channel, private: value }),
  );

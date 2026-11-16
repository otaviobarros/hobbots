import type { Channel } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { placeChannel, queryKeys } from "./queries.ts";
import { recordChannel } from "./sync.ts";

/**
 * Archives a channel. It leaves the hob's channel list at once; a refusal or a failure puts it back
 * where it was. The archived channel the hub returns goes to the hob's archived list, and other
 * clients hear of it from its event.
 */
export const useArchiveChannel = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channel: Channel) => call((c) => c.channels.archive({ params: { channelId: channel.id } })),
    onMutate: (channel) => {
      queryClient.setQueryData<ReadonlyArray<Channel>>(queryKeys.channels(channel.ownerHobId), (old) =>
        old?.filter((t) => t.id !== channel.id),
      );
    },
    onError: (_, channel) => placeChannel(queryClient, channel),
    onSuccess: (archived) => {
      recordChannel(queryClient, archived);
      placeChannel(queryClient, archived);
    },
  });
};

/** Undoes an archive: the channel is restored and goes back to its place by last activity. */
export const useUndoArchive = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channel: Channel) => call((c) => c.channels.restore({ params: { channelId: channel.id } })),
    onSuccess: (restored) => {
      recordChannel(queryClient, restored);
      placeChannel(queryClient, restored);
    },
  });
};

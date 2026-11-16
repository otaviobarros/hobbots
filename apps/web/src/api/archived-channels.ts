import type { ChannelId } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { placeChannel } from "./queries.ts";

/**
 * Restores an archived channel: it leaves the archived list and goes back to its place in the hob's
 * channel list by last activity, taking messages again.
 */
export const useRestoreChannel = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: ChannelId) => call((c) => c.channels.restore({ params: { channelId } })),
    onSuccess: (channel) => placeChannel(queryClient, channel),
  });
};

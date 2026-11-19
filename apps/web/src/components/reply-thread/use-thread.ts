import { type AgentId, type ChannelId, MessageId } from "@hobbots/domain";
import { useNavigate, useSearch } from "@tanstack/react-router";

const CHANNEL = "/hobs/$hobId/channels/$channelId";

/**
 * The reply thread open beside the chat, which the address keeps (`?thread=`), so a link or a reload
 * opens it again and Back closes it. Opening one leaves the rest of the address as it was.
 */
export const useOpenThread = (hobId: AgentId, channelId: ChannelId | undefined) => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const go = (thread: MessageId | undefined) =>
    channelId !== undefined &&
    void navigate({
      to: CHANNEL,
      params: { hobId, channelId },
      search: (prev: Record<string, unknown>) => ({ ...prev, thread }),
    });
  return {
    open: channelId === undefined || search.thread === undefined ? undefined : MessageId.make(search.thread),
    show: (rootId: MessageId) => go(rootId),
    close: () => go(undefined),
  };
};

export type OpenThread = ReturnType<typeof useOpenThread>;

import type { ChannelId, HobbotsEvent, Message, MessageId, MessagePin } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents, queryKeys } from "./queries.ts";
import { forgetArtifactReads, readListAgain, recordKeys } from "./records.ts";
import { recordMessage } from "./sync.ts";

// What is yours in a chat or camp (ADR 037, Mine): notes to self, which wake no hob, and pins; and
// catch-up, what changed there since you last read it, as the hub works it out.

/**
 * A chapter moved between `channels`: the decisions and artifacts it made, and the pins on its
 * messages, went with it, and no record or pin event says so, so each channel's lists are read again
 * (STD-REACT-012), and the artifacts' versions and contents, which the move may have numbered again,
 * are dropped.
 */
export const recordsMoved = (queryClient: QueryClient, channels: ReadonlyArray<ChannelId>): Promise<unknown> =>
  Promise.all(
    channels.flatMap((channelId) => [
      ...[recordKeys.decisions(channelId), recordKeys.artifacts(channelId), pinsKey(channelId)].map((queryKey) =>
        readListAgain(queryClient, queryKey),
      ),
      forgetArtifactReads(queryClient, channelId),
    ]),
  );

const pinsKey = (channelId: ChannelId) => ["channels", channelId, "pins"] as const;

/** The channel's pins, the newest first. */
export const pinsQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: pinsKey(channelId),
    queryFn: () => call((c) => c.notes.pins({ params: { channelId } })),
    ...followsEvents,
  });

type PinEvent = Extract<HobbotsEvent, { readonly _tag: "MessagePinned" | "MessageUnpinned" }>;
export const isPinEvent = (event: HobbotsEvent): event is PinEvent =>
  event._tag === "MessagePinned" || event._tag === "MessageUnpinned";

/** A message was pinned or unpinned, here or on another device: the channel's pins are read again. */
export const applyPinEvent = (queryClient: QueryClient, event: PinEvent): Promise<void> =>
  readListAgain(queryClient, pinsKey(event._tag === "MessagePinned" ? event.pin.channelId : event.channelId));

/** Pins or unpins a message of the channel; the list takes the change once the hub answers. */
export const useSetPinned = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, pinned }: { readonly messageId: MessageId; readonly pinned: boolean }) =>
      call((c) => c.notes.pinMessage({ params: { channelId, messageId }, payload: { pinned } })),
    onSuccess: (pin, { messageId }) =>
      queryClient.setQueryData<ReadonlyArray<MessagePin>>(pinsKey(channelId), (old) => {
        if (old === undefined) return old;
        const others = old.filter((each) => each.messageId !== messageId);
        return pin === null ? others : [pin, ...others];
      }),
  });
};

/**
 * Writes a note to self under `key`, which becomes its id, so a retry after a lost answer writes it
 * once. The note joins the transcript at once; no hob wakes.
 */
export const useWriteNote = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, content }: { readonly key: MessageId; readonly content: string }) =>
      call((c) => c.notes.writeNote({ params: { channelId }, payload: { key, content } })),
    onSuccess: (note) => {
      recordMessage(queryClient, note);
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(channelId), (old) =>
        old === undefined || old.some((each) => each.id === note.id) ? old : [...old, note],
      );
    },
  });
};

/**
 * What changed in the channel since you last read it, read once each time you come back to it unread
 * (`visit`), before the chat marks itself read, since reading moves the marker past it. It stays as
 * it was read for the visit: catching up is about what you missed while away. `visit` is unique to
 * the visit, even across a chat view that unmounts and mounts again, and the snapshot is dropped as
 * soon as nothing reads it, so a later visit never shows an earlier one's news.
 */
export const catchUpQuery = (channelId: ChannelId, visit: string) =>
  queryOptions({
    queryKey: ["channels", channelId, "catchUp", visit] as const,
    queryFn: () => call((c) => c.notes.catchUp({ params: { channelId } })),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: 1,
  });

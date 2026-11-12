import type { HobbotsEvent, Message, MessageId, MessagePin, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents, queryKeys } from "./queries.ts";
import { readListAgain, recordKeys } from "./records.ts";
import { recordMessage } from "./sync.ts";

// What is yours in a chat or camp (ADR 037, Mine): notes to self, which wake no hob, and pins; and
// catch-up, what changed there since you last read it, as the hub works it out.

/**
 * A chapter moved between `threads`: the decisions and artifacts it made, and the pins on its
 * messages, went with it, and no record or pin event says so, so each thread's lists are read again
 * (STD-REACT-012).
 */
export const recordsMoved = (queryClient: QueryClient, threads: ReadonlyArray<ThreadId>): Promise<unknown> =>
  Promise.all(
    threads.flatMap((threadId) =>
      [recordKeys.decisions(threadId), recordKeys.artifacts(threadId), pinsKey(threadId)].map((queryKey) =>
        readListAgain(queryClient, queryKey),
      ),
    ),
  );

const pinsKey = (threadId: ThreadId) => ["threads", threadId, "pins"] as const;

/** The thread's pins, the newest first. */
export const pinsQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: pinsKey(threadId),
    queryFn: () => call((c) => c.notes.pins({ params: { threadId } })),
    ...followsEvents,
  });

type PinEvent = Extract<HobbotsEvent, { readonly _tag: "MessagePinned" | "MessageUnpinned" }>;
export const isPinEvent = (event: HobbotsEvent): event is PinEvent =>
  event._tag === "MessagePinned" || event._tag === "MessageUnpinned";

/** A message was pinned or unpinned, here or on another device: the thread's pins are read again. */
export const applyPinEvent = (queryClient: QueryClient, event: PinEvent): Promise<void> =>
  readListAgain(queryClient, pinsKey(event._tag === "MessagePinned" ? event.pin.threadId : event.threadId));

/** Pins or unpins a message of the thread; the list takes the change once the hub answers. */
export const useSetPinned = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, pinned }: { readonly messageId: MessageId; readonly pinned: boolean }) =>
      call((c) => c.notes.pinMessage({ params: { threadId, messageId }, payload: { pinned } })),
    onSuccess: (pin, { messageId }) =>
      queryClient.setQueryData<ReadonlyArray<MessagePin>>(pinsKey(threadId), (old) => {
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
export const useWriteNote = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, content }: { readonly key: MessageId; readonly content: string }) =>
      call((c) => c.notes.writeNote({ params: { threadId }, payload: { key, content } })),
    onSuccess: (note) => {
      recordMessage(queryClient, note);
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId), (old) =>
        old === undefined || old.some((each) => each.id === note.id) ? old : [...old, note],
      );
    },
  });
};

/**
 * What changed in the thread since you last read it, read once each time you come back to it unread
 * (`visit`), before the chat marks itself read, since reading moves the marker past it. It stays as
 * it was read for the visit: catching up is about what you missed while away. `visit` is unique to
 * the visit, even across a chat view that unmounts and mounts again, and the snapshot is dropped as
 * soon as nothing reads it, so a later visit never shows an earlier one's news.
 */
export const catchUpQuery = (threadId: ThreadId, visit: string) =>
  queryOptions({
    queryKey: ["threads", threadId, "catchUp", visit] as const,
    queryFn: () => call((c) => c.notes.catchUp({ params: { threadId } })),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: 1,
  });

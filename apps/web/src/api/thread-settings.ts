import { Thread } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { placeThread, queryKeys } from "./queries.ts";
import { recordThread } from "./sync.ts";

/**
 * Changes a thread in its hob's list at once, then sends the change. The thread the hub returns
 * takes its place; a failure puts the thread back as it was. Other clients hear of it from its event.
 */
const useThreadChange = <V>(
  send: (thread: Thread, value: V) => Promise<Thread>,
  apply: (thread: Thread, value: V) => Thread,
) => {
  const queryClient = useQueryClient();
  const swap = (next: Thread) =>
    queryClient.setQueryData<ReadonlyArray<Thread>>(queryKeys.threads(next.agentId), (old) =>
      old?.map((t) => (t.id === next.id ? next : t)),
    );
  return useMutation({
    mutationFn: ({ thread, value }: { thread: Thread; value: V }) => send(thread, value),
    onMutate: ({ thread, value }) => swap(apply(thread, value)),
    onError: (_, { thread }) => swap(thread),
    onSuccess: (changed) => {
      recordThread(queryClient, changed);
      placeThread(queryClient, changed);
    },
  });
};

/** Renames a thread to a title already trimmed and not empty. */
export const useRenameThread = () =>
  useThreadChange<string>(
    (thread, title) => call((c) => c.threads.rename({ params: { threadId: thread.id }, payload: { title } })),
    (thread, title) => new Thread({ ...thread, title }),
  );

/** Pins a thread to the top of its hob's chats, or unpins it. */
export const usePinThread = () =>
  useThreadChange<boolean>(
    (thread, pinned) => call((c) => c.threads.pin({ params: { threadId: thread.id }, payload: { pinned } })),
    (thread, pinned) => new Thread({ ...thread, pinnedAt: pinned ? new Date().toISOString() : null }),
  );

import type { Thread } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { placeThread, queryKeys } from "./queries.ts";
import { recordThread } from "./sync.ts";

/**
 * Archives a thread. It leaves the hob's thread list at once; a refusal or a failure puts it back
 * where it was. The archived thread the hub returns goes to the hob's archived list, and other
 * clients hear of it from its event.
 */
export const useArchiveThread = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (thread: Thread) => call((c) => c.threads.archive({ params: { threadId: thread.id } })),
    onMutate: (thread) => {
      queryClient.setQueryData<ReadonlyArray<Thread>>(queryKeys.threads(thread.agentId), (old) =>
        old?.filter((t) => t.id !== thread.id),
      );
    },
    onError: (_, thread) => placeThread(queryClient, thread),
    onSuccess: (archived) => {
      recordThread(queryClient, archived);
      placeThread(queryClient, archived);
    },
  });
};

/** Undoes an archive: the thread is restored and goes back to its place by last activity. */
export const useUndoArchive = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (thread: Thread) => call((c) => c.threads.restore({ params: { threadId: thread.id } })),
    onSuccess: (restored) => {
      recordThread(queryClient, restored);
      placeThread(queryClient, restored);
    },
  });
};

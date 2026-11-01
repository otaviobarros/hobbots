import type { ThreadId } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { placeThread } from "./queries.ts";

/**
 * Restores an archived thread: it leaves the archived list and goes back to its place in the hob's
 * thread list by last activity, taking messages again.
 */
export const useRestoreThread = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: ThreadId) => call((c) => c.threads.restore({ params: { threadId } })),
    onSuccess: (thread) => placeThread(queryClient, thread),
  });
};

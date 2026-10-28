import type { Message, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";

/** What a thread's hob is doing right now, learned from live events. Absent means idle. */
export type ThreadActivity = "thinking" | "working";
export type ActivityMap = Readonly<Record<ThreadId, ThreadActivity>>;

const activityKey = ["activity"] as const;

export const activityQuery = queryOptions({
  queryKey: activityKey,
  queryFn: (): ActivityMap => ({}),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
});

export const setActivity = (queryClient: QueryClient, threadId: ThreadId, activity: ThreadActivity | null) =>
  queryClient.setQueryData<ActivityMap>(activityKey, (old = {}) => {
    if ((old[threadId] ?? null) === activity) return old;
    const next = { ...old };
    if (activity) next[threadId] = activity;
    else delete next[threadId];
    return next;
  });

export const recordActivity = (queryClient: QueryClient, message: Message) =>
  setActivity(
    queryClient,
    message.threadId,
    message.status === "streaming" ? (message.content.length > 0 ? "working" : "thinking") : null,
  );

export const useActivity = (): ActivityMap => useQuery(activityQuery).data ?? {};

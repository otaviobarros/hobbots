import {
  type AgentId,
  isInProgress,
  leavesUnread,
  type Message,
  type MessageId,
  Thread,
  type ThreadId,
} from "@hobbots/domain";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { call } from "./client.ts";
import { placeThread, queryKeys } from "./queries.ts";

/** The hob's thread lists, live and archived, as Query holds them. */
const threadLists = (queryClient: QueryClient) =>
  queryClient.getQueriesData<ReadonlyArray<Thread>>({
    predicate: (query) =>
      query.queryKey[0] === "agents" && /^(threads|archivedThreads)$/.test(String(query.queryKey[2])),
  });

/** Sets whether a thread is unread in every list that holds it, without a new revision. */
const setUnread = (queryClient: QueryClient, threadId: ThreadId, unread: boolean) => {
  for (const [key, threads] of threadLists(queryClient)) {
    if (!threads?.some((thread) => thread.id === threadId && thread.unread !== unread)) continue;
    queryClient.setQueryData<ReadonlyArray<Thread>>(key, (old) =>
      old?.map((thread) => (thread.id === threadId ? new Thread({ ...thread, unread }) : thread)),
    );
  }
};

/**
 * A reply that just ended leaves its thread unread in the hob's lists, as the hub works it out when
 * it reads them (ADR 027), so the dot shows as the reply lands. Call it before the transcript takes
 * the new copy: a reply the transcript already held as ended was there before, maybe already read.
 * The chat open in front reads it again at once.
 */
export const showUnread = (queryClient: QueryClient, message: Message) => {
  if (!leavesUnread(message)) return;
  const held = queryClient
    .getQueryData<ReadonlyArray<Message>>(queryKeys.messages(message.threadId))
    ?.find((each) => each.id === message.id);
  if (held !== undefined && leavesUnread(held)) return;
  setUnread(queryClient, message.threadId, true);
};

const onVisibility = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};

/** Whether the page is in front: a chat behind another window or tab is not being read. */
const usePageShown = () =>
  useSyncExternalStore(
    onVisibility,
    () => document.visibilityState === "visible",
    () => true,
  );

/**
 * The last message of the transcript you have seen whole: a reply still under way is read once it
 * ends, so leaving before then still leaves its dot.
 */
export const lastRead = (transcript: ReadonlyArray<Message> | undefined): Message | undefined =>
  transcript?.findLast((message) => message.status !== "queued" && !isInProgress(message.status));

/**
 * Marks the open chat read on the hub while the page is in front and the thread shows unread, so
 * its dot clears on every device (ADR 027). The dot clears here at once; the hub's answer and
 * event bring the thread's new revision.
 */
export const useReadThread = (
  hobId: AgentId,
  thread: Thread | undefined,
  transcript: ReadonlyArray<Message> | undefined,
) => {
  const queryClient = useQueryClient();
  const shown = usePageShown();
  const through: MessageId | undefined = lastRead(transcript)?.id;
  const threadId = thread?.id;
  const unread = thread?.unread === true;
  useEffect(() => {
    if (!shown || !unread || threadId === undefined || through === undefined) return;
    setUnread(queryClient, threadId, false);
    call((c) => c.threads.markRead({ params: { threadId }, payload: { messageId: through } })).then(
      (read) => placeThread(queryClient, read),
      // The dot comes back with the next read of the list; nothing else depends on it.
      () => void queryClient.invalidateQueries({ queryKey: ["agents", hobId, "threads"], exact: true }),
    );
  }, [queryClient, hobId, threadId, through, shown, unread]);
};

import { isInProgress, leavesUnread, type Message, type MessageId, type Thread, type ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { call } from "./client.ts";
import { followsEvents, queryKeys } from "./queries.ts";
import { mentionsYou, sidebarChanged, sidebarQuery } from "./sidebar.ts";
import { syncedUnread } from "./sync.ts";

/**
 * The threads unread for you, as the hub works them out from your own read markers (ADR 039), with
 * the replies that landed since added.
 */
export const unreadThreadsQuery = queryOptions({
  queryKey: queryKeys.unreadThreads,
  ...followsEvents,
  queryFn: syncedUnread(() => call((c) => c.threads.unreadThreads())),
});

const NONE: ReadonlySet<ThreadId> = new Set();
const asSet = (ids: ReadonlyArray<ThreadId>): ReadonlySet<ThreadId> => new Set(ids);

/** The threads unread for you, or undefined until the hub answers. */
export const useKnownUnreadThreads = (): ReadonlySet<ThreadId> | undefined =>
  useQuery({ ...unreadThreadsQuery, select: asSet }).data;

/** The threads unread for you; none until the hub answers. */
export const useUnreadThreads = (): ReadonlySet<ThreadId> => useKnownUnreadThreads() ?? NONE;

/**
 * Who read what changed, here or on another device, or a chapter moved messages: your unread threads
 * are read again. A read already in flight may have been taken before the change, and while the list
 * has no data yet Query would hand that read back instead of starting another, so it is cancelled
 * first (STD-REACT-012).
 */
export const unreadChanged = async (queryClient: QueryClient) => {
  // The sidebar's unread counts come from the same markers.
  void sidebarChanged(queryClient);
  await queryClient.cancelQueries({ queryKey: queryKeys.unreadThreads, exact: true });
  await queryClient.invalidateQueries({ queryKey: queryKeys.unreadThreads, exact: true });
};

/** Sets whether a thread is unread for you, until the hub's list is read again. */
const setUnread = (queryClient: QueryClient, threadId: ThreadId, unread: boolean) =>
  queryClient.setQueryData<ReadonlyArray<ThreadId>>(queryKeys.unreadThreads, (old) => {
    if (old === undefined || old.includes(threadId) === unread) return old;
    return unread ? [...old, threadId] : old.filter((id) => id !== threadId);
  });

/**
 * A reply that just ended leaves its thread unread for you, as the hub works it out when it reads
 * your markers (ADR 027, ADR 039), so the dot shows as the reply lands. Call it before the transcript takes
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
  // The sidebar counts the new reply.
  void sidebarChanged(queryClient);
};

const onVisibility = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};

/** Whether the page is in front: a chat behind another window or tab is not being read. */
export const usePageShown = () =>
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
 * What you read the transcript through: its last message you have seen whole, and the newest
 * revision you saw up to it, so the hub never counts read a reply continued after that (ADR 027).
 */
export const readThrough = (
  transcript: ReadonlyArray<Message> | undefined,
): { readonly messageId: MessageId; readonly revision: number } | undefined => {
  const last = lastRead(transcript);
  if (last === undefined || transcript === undefined) return undefined;
  const upTo = transcript.slice(0, transcript.indexOf(last) + 1);
  return { messageId: last.id, revision: Math.max(...upTo.map((message) => message.revision)) };
};

/**
 * Marks the open chat read on the hub while it is in view, on a page in front, and the thread shows
 * unread, a reply or a mention of you the sidebar counts, so its dot and `@` clear on every device of
 * yours (ADR 027, ADR 039). A chat folded away beside a quest's Workbench is not in view. The dot
 * clears here at once; your member row's event and a fresh read of the sidebar bring the rest.
 */
export const useReadThread = (
  thread: Thread | undefined,
  transcript: ReadonlyArray<Message> | undefined,
  inView: boolean,
) => {
  const queryClient = useQueryClient();
  const shown = usePageShown() && inView;
  const through = readThrough(transcript);
  const messageId = through?.messageId;
  const revision = through?.revision;
  const threadId = thread?.id;
  const replies = useUnreadThreads().has(threadId as ThreadId);
  // A person's message that mentions you leaves no unread reply, so the sidebar's `@` counts too.
  const { data: sidebar } = useQuery(sidebarQuery);
  const unread = replies || (threadId !== undefined && mentionsYou(sidebar, threadId));
  useEffect(() => {
    if (!shown || !unread || threadId === undefined || messageId === undefined || revision === undefined) return;
    setUnread(queryClient, threadId, false);
    call((c) => c.threads.markRead({ params: { threadId }, payload: { messageId, revision } })).then(
      () => void sidebarChanged(queryClient),
      // The dot comes back with the next read of the list; nothing else depends on it.
      () => void unreadChanged(queryClient),
    );
  }, [queryClient, threadId, messageId, revision, shown, unread]);
};

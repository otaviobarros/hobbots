import type { MakeCampPayload } from "@hobbots/api";
import { type AgentId, type Thread, type ThreadId, ThreadLifecycle } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { placeThread, queryKeys } from "./queries.ts";
import { questionsMoved } from "./questions.ts";
import { recordThread } from "./sync.ts";
import { threadTasksMoved } from "./tasks.ts";

// Make a camp and Start fresh (ADR 037). Both take a key the client makes, which becomes the new
// thread's id, so sending the same request again, as a retry after a lost answer does, changes nothing.

const carryOverKey = (threadId: ThreadId) => ["threads", threadId, "carryOver"] as const;

/**
 * What Start fresh would carry over from the chat now, read each time its sheet opens: no event says
 * when it changes, and the sheet is open only for a moment.
 */
export const carryOverQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: carryOverKey(threadId),
    queryFn: () => call((c) => c.threads.carryOver({ params: { threadId } })),
    staleTime: 0,
  });

/** The hob's open chat, the one the sidebar lists first and opening the hob opens, if it has one. */
export const openChatOf = (threads: ReadonlyArray<Thread> | undefined): Thread | undefined =>
  threads?.find(ThreadLifecycle.isOpenChat);

/**
 * The hob's camps, pinned first, the most recently pinned on top, then the rest in the order of its
 * thread list, by last activity.
 */
export const campsOf = (threads: ReadonlyArray<Thread> | undefined): ReadonlyArray<Thread> => {
  const camps = threads?.filter((thread) => thread.kind === "camp") ?? [];
  const pinned = camps
    .filter((camp) => camp.pinnedAt !== null)
    .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
  return [...pinned, ...camps.filter((camp) => camp.pinnedAt === null)];
};

const show = (queryClient: QueryClient, thread: Thread) => {
  recordThread(queryClient, thread);
  placeThread(queryClient, thread);
};

/**
 * A chat was started fresh, here or by its event: the old chat moves to the hob's archived threads
 * and the new one joins its list. The Tasks started there moved with it, so both chats read their
 * work again, and the questions waiting for you read again the chat each now belongs to.
 */
export const chatStartedFresh = (
  queryClient: QueryClient,
  { superseded, chat }: { readonly superseded: Thread; readonly chat: Thread },
) => {
  for (const thread of [superseded, chat]) {
    show(queryClient, thread);
    void threadTasksMoved(queryClient, thread.id);
  }
  // A read already on its way may predate the move, so it is cancelled first (STD-REACT-012).
  void questionsMoved(queryClient);
};

/**
 * A chapter moved into a camp (ADR 037): both threads take their new rows, and read their
 * transcripts and their work again, since messages and the quests started in the chapter moved, as
 * did the questions waiting in those quests.
 */
export const chapterMoved = (
  queryClient: QueryClient,
  { thread, camp }: { readonly thread: Thread; readonly camp: Thread },
) => {
  for (const each of [thread, camp]) {
    show(queryClient, each);
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages(each.id), exact: true });
    void threadTasksMoved(queryClient, each.id);
  }
  void questionsMoved(queryClient);
};

/** Makes a camp for the hob; it joins the hob's list at once, before its event arrives. */
export const useMakeCamp = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: MakeCampPayload) => call((c) => c.agents.makeCamp({ params: { agentId }, payload })),
    onSuccess: (camp) => {
      // A new thread has no messages yet, so its transcript shows at once instead of loading.
      queryClient.setQueryData(queryKeys.messages(camp.id), (old: ReadonlyArray<unknown> | undefined) => old ?? []);
      show(queryClient, camp);
    },
  });
};

/**
 * Starts the hob's chat fresh: the old chat moves to the archived list and the new one takes its
 * place. The Tasks started there moved with it, so both chats read their work again.
 */
export const useStartFresh = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ thread, key }: { thread: Thread; key: ThreadId }) =>
      call((c) => c.threads.startFresh({ params: { threadId: thread.id }, payload: { key } })),
    onSuccess: (started) => {
      chatStartedFresh(queryClient, started);
      void queryClient.invalidateQueries({ queryKey: carryOverKey(started.superseded.id), exact: true });
    },
  });
};

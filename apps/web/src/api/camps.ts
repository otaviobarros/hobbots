import type { MakeCampPayload } from "@hobbots/api";
import { type AgentId, type Chapter, type Thread, type ThreadId, ThreadLifecycle } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { chaptersMoved } from "./chapters.ts";
import { call } from "./client.ts";
import { recordsMoved } from "./notes.ts";
import { placeThread, queryKeys } from "./queries.ts";
import { questionsMoved } from "./questions.ts";
import { recordMovedMessages, recordThread } from "./sync.ts";
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
 * A chapter moved into a camp (ADR 037): both threads take their new rows and chapters, and read
 * their transcripts and their work again, since messages and the quests started in the chapter
 * moved, as did the questions waiting in those quests, and the chapter's decisions, artifacts and pins.
 */
export const chapterMoved = async (
  queryClient: QueryClient,
  {
    thread,
    camp,
    stub,
    chapter,
    chapters,
    campChapters,
  }: {
    readonly thread: Thread;
    readonly camp: Thread;
    readonly stub: Chapter;
    readonly chapter: Chapter;
    readonly chapters: ReadonlyArray<Chapter>;
    readonly campChapters: ReadonlyArray<Chapter>;
  },
): Promise<void> => {
  // Messages an event brought this generation say where they are now, or a read would add them back.
  recordMovedMessages(queryClient, { stub, chapter });
  for (const each of [thread, camp]) show(queryClient, each);
  // A transcript read already on its way may predate the move, and messages it read before any event
  // brought them are in no overlay, so it is cancelled before both are read again (STD-REACT-012).
  await Promise.all(
    [thread, camp].map((each) => queryClient.cancelQueries({ queryKey: queryKeys.messages(each.id), exact: true })),
  );
  for (const each of [thread, camp]) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages(each.id), exact: true });
    void threadTasksMoved(queryClient, each.id);
  }
  void chaptersMoved(queryClient, [
    { threadId: thread.id, chapters },
    { threadId: camp.id, chapters: campChapters },
  ]);
  void questionsMoved(queryClient);
  void recordsMoved(queryClient, [thread.id, camp.id]);
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

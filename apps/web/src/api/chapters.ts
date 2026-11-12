import type { SplitChapterPayload } from "@hobbots/api";
import type { Chapter, ChapterId, HobbotsEvent, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents, queryKeys } from "./queries.ts";

// A thread's chapters (ADR 037, #1382), which the transcript is divided by, and what the Focus chip
// shows the hob reads. Chapter events keep the list current; a split or a merge also moves messages
// between chapters, so the transcript is read again then (events.ts).

const chaptersKey = (threadId: ThreadId) => ["threads", threadId, "chapters"] as const;
const focusKey = (threadId: ThreadId) => ["threads", threadId, "focus"] as const;

/** The thread's chapters in order, moved ones included. */
export const chaptersQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: chaptersKey(threadId),
    queryFn: () => call((c) => c.chapters.list({ params: { threadId } })),
    ...followsEvents,
  });

/**
 * What the hob reads each turn, read each time the Focus chip opens: the report changes with every
 * new session, and no event announces it.
 */
export const focusQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: focusKey(threadId),
    queryFn: () => call((c) => c.chapters.focus({ params: { threadId } })),
    staleTime: 0,
  });

/** The newest change among chapters, so an older list never replaces a newer one. */
const newest = (chapters: ReadonlyArray<Chapter>) => Math.max(0, ...chapters.map((chapter) => chapter.revision));

/** Takes `chapters`, the thread's whole list after a change, unless the list held is newer. */
const takeList = (queryClient: QueryClient, threadId: ThreadId, chapters: ReadonlyArray<Chapter>) =>
  queryClient.setQueryData<ReadonlyArray<Chapter>>(chaptersKey(threadId), (old) =>
    old !== undefined && newest(old) > newest(chapters) ? old : chapters,
  );

/** Puts `changed` in the list, each in its place or after the rest, unless the list holds a newer version. */
const takeChapters = (queryClient: QueryClient, threadId: ThreadId, changed: ReadonlyArray<Chapter>) =>
  queryClient.setQueryData<ReadonlyArray<Chapter>>(chaptersKey(threadId), (old) => {
    if (old === undefined) return old;
    let next = old;
    for (const chapter of changed) {
      const held = next.find((each) => each.id === chapter.id);
      if (held === undefined) next = [...next, chapter].sort((a, b) => a.number - b.number);
      else if (held.revision <= chapter.revision) next = next.map((each) => (each.id === chapter.id ? chapter : each));
    }
    return next;
  });

type ChapterEvent = Extract<
  HobbotsEvent,
  { readonly _tag: "ChapterStarted" | "ChapterSplit" | "ChapterMerged" | "ChapterSummarized" }
>;

/**
 * A chapter changed (ADR 037). A read already on its way may predate the change, so it is
 * cancelled first (STD-REACT-012); with no list held yet, the next read brings the change.
 */
export const applyChapterEvent = async (queryClient: QueryClient, event: ChapterEvent): Promise<void> => {
  const key = chaptersKey(event.threadId);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  if (queryClient.getQueryData(key) === undefined) {
    await queryClient.invalidateQueries({ queryKey: key, exact: true });
    return;
  }
  switch (event._tag) {
    case "ChapterStarted":
      takeChapters(queryClient, event.threadId, event.ended === null ? [event.chapter] : [event.ended, event.chapter]);
      return;
    case "ChapterSummarized":
      takeChapters(queryClient, event.threadId, [event.chapter]);
      return;
    case "ChapterSplit":
    case "ChapterMerged":
      takeList(queryClient, event.threadId, event.chapters);
  }
};

/** After a split or a merge, the thread's chapters as the hub answered, and its messages read again. */
const changed = (queryClient: QueryClient, threadId: ThreadId, chapters: ReadonlyArray<Chapter>) => {
  takeList(queryClient, threadId, chapters);
  void queryClient.invalidateQueries({ queryKey: queryKeys.messages(threadId), exact: true });
};

/** Split here: the messages from `messageId` on start a new chapter titled `title`. */
export const useSplitChapter = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SplitChapterPayload) => call((c) => c.chapters.split({ params: { threadId }, payload })),
    onSuccess: (chapters) => changed(queryClient, threadId, chapters),
  });
};

/** Merge with previous: the chapter's messages join the chapter before it. */
export const useMergeChapter = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chapterId: ChapterId) => call((c) => c.chapters.merge({ params: { threadId, chapterId } })),
    onSuccess: (chapters) => changed(queryClient, threadId, chapters),
  });
};

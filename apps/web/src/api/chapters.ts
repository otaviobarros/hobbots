import type { SplitChapterPayload } from "@hobbots/api";
import type { ChannelId, Chapter, ChapterId, HobbotsEvent } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents, queryKeys } from "./queries.ts";

// A channel's chapters (ADR 037, #1382), which the transcript is divided by, and what the Focus chip
// shows the hob reads. Chapter events keep the list current; a split or a merge also moves messages
// between chapters, so the transcript is read again then (events.ts).

const chaptersKey = (channelId: ChannelId) => ["channels", channelId, "chapters"] as const;
const focusKey = (channelId: ChannelId) => ["channels", channelId, "focus"] as const;

/** The channel's chapters in order, moved ones included. */
export const chaptersQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: chaptersKey(channelId),
    queryFn: () => call((c) => c.chapters.list({ params: { channelId } })),
    ...followsEvents,
  });

/**
 * What the hob reads each turn, read each time the Focus chip opens: the report changes with every
 * new session, and no event announces it.
 */
export const focusQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: focusKey(channelId),
    queryFn: () => call((c) => c.chapters.focus({ params: { channelId } })),
    staleTime: 0,
  });

/** The newest change among chapters, so an older list never replaces a newer one. */
const newest = (chapters: ReadonlyArray<Chapter>) => Math.max(0, ...chapters.map((chapter) => chapter.revision));

/** Takes `chapters`, the channel's whole list after a change, unless the list held is newer. */
const takeList = (queryClient: QueryClient, channelId: ChannelId, chapters: ReadonlyArray<Chapter>) =>
  queryClient.setQueryData<ReadonlyArray<Chapter>>(chaptersKey(channelId), (old) =>
    old !== undefined && newest(old) > newest(chapters) ? old : chapters,
  );

/** Puts `changed` in the list, each in its place or after the rest, unless the list holds a newer version. */
const takeChapters = (queryClient: QueryClient, channelId: ChannelId, changed: ReadonlyArray<Chapter>) =>
  queryClient.setQueryData<ReadonlyArray<Chapter>>(chaptersKey(channelId), (old) => {
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
  const key = chaptersKey(event.channelId);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  if (queryClient.getQueryData(key) === undefined) {
    await queryClient.invalidateQueries({ queryKey: key, exact: true });
    return;
  }
  switch (event._tag) {
    case "ChapterStarted":
      takeChapters(queryClient, event.channelId, event.ended === null ? [event.chapter] : [event.ended, event.chapter]);
      return;
    case "ChapterSummarized":
      takeChapters(queryClient, event.channelId, [event.chapter]);
      return;
    case "ChapterSplit":
    case "ChapterMerged":
      takeList(queryClient, event.channelId, event.chapters);
  }
};

/**
 * A chapter moved into a camp (ADR 037): each channel takes its chapters as the move left them. A read
 * already on its way may predate the move, so it is cancelled first (STD-REACT-012).
 */
export const chaptersMoved = async (
  queryClient: QueryClient,
  lists: ReadonlyArray<{ readonly channelId: ChannelId; readonly chapters: ReadonlyArray<Chapter> }>,
): Promise<void> => {
  await Promise.all(
    lists.map(({ channelId }) => queryClient.cancelQueries({ queryKey: chaptersKey(channelId), exact: true })),
  );
  for (const { channelId, chapters } of lists) {
    if (queryClient.getQueryData(chaptersKey(channelId)) === undefined) {
      void queryClient.invalidateQueries({ queryKey: chaptersKey(channelId), exact: true });
    } else takeList(queryClient, channelId, chapters);
  }
};

/** After a split or a merge, the channel's chapters as the hub answered, and its messages read again. */
const changed = (queryClient: QueryClient, channelId: ChannelId, chapters: ReadonlyArray<Chapter>) => {
  takeList(queryClient, channelId, chapters);
  void queryClient.invalidateQueries({ queryKey: queryKeys.messages(channelId), exact: true });
};

/** Split here: the messages from `messageId` on start a new chapter titled `title`. */
export const useSplitChapter = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SplitChapterPayload) => call((c) => c.chapters.split({ params: { channelId }, payload })),
    onSuccess: (chapters) => changed(queryClient, channelId, chapters),
  });
};

/** Merge with previous: the chapter's messages join the chapter before it. */
export const useMergeChapter = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chapterId: ChapterId) => call((c) => c.chapters.merge({ params: { channelId, chapterId } })),
    onSuccess: (chapters) => changed(queryClient, channelId, chapters),
  });
};

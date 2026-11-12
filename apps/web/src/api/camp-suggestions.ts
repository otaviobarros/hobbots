import type { MoveChapterPayload } from "@hobbots/api";
import type { CampSuggestion, CampSuggestionId, ChapterId, HobbotsEvent, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { chapterMoved } from "./camps.ts";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { readListAgain } from "./records.ts";

// Camp suggestions (ADR 037, #1385), as the suggestion card in the chat shows them: the open ones the
// hub raised. You keep the chapter in the chat, or move it into a camp, which accepts its suggestion.

const suggestionsKey = (threadId: ThreadId) => ["threads", threadId, "campSuggestions"] as const;

/** The chat's open camp suggestions. */
export const campSuggestionsQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: suggestionsKey(threadId),
    queryFn: () => call((c) => c.campSuggestions.campSuggestions({ params: { threadId } })),
    ...followsEvents,
  });

type SuggestionEvent = Extract<
  HobbotsEvent,
  {
    readonly _tag: "CampSuggested" | "CampSuggestionKept" | "CampSuggestionAccepted" | "CampSuggestionExpired";
  }
>;
const SUGGESTION_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "CampSuggested",
  "CampSuggestionKept",
  "CampSuggestionAccepted",
  "CampSuggestionExpired",
]);
export const isSuggestionEvent = (event: HobbotsEvent): event is SuggestionEvent => SUGGESTION_EVENTS.has(event._tag);

/** A suggestion was raised or settled: the chat's open ones are read again. */
export const applySuggestionEvent = (queryClient: QueryClient, event: SuggestionEvent): Promise<void> =>
  readListAgain(queryClient, suggestionsKey(event.threadId));

/** Leaves out a settled suggestion at once, before its event arrives. */
const settle = (queryClient: QueryClient, suggestion: CampSuggestion) =>
  queryClient.setQueryData<ReadonlyArray<CampSuggestion>>(suggestionsKey(suggestion.threadId), (old) =>
    old?.filter((each) => each.id !== suggestion.id),
  );

/** Keep in chat: the chapter stays, and it is never suggested again. */
export const useKeepInChat = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (suggestionId: CampSuggestionId) =>
      call((c) => c.campSuggestions.keepInChat({ params: { threadId, suggestionId } })),
    onSuccess: (kept) => settle(queryClient, kept),
  });
};

/** Moves a chapter of the thread into a camp, a new one or an open one of the hob's. */
export const useMoveChapter = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chapterId, into }: { readonly chapterId: ChapterId; readonly into: MoveChapterPayload }) =>
      call((c) => c.campSuggestions.moveChapter({ params: { threadId, chapterId }, payload: into })),
    onSuccess: async (moved) => {
      queryClient.setQueryData(suggestionsKey(threadId), (old: ReadonlyArray<CampSuggestion> | undefined) =>
        old?.filter((each) => each.chapterId !== moved.stub.id),
      );
      // The moved chapter, as it now stands in the camp, is the camp's last one.
      const chapter = moved.campChapters.at(-1);
      if (chapter !== undefined) await chapterMoved(queryClient, { ...moved, chapter });
    },
  });
};

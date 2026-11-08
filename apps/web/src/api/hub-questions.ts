import type { HubQuestion, HubQuestionId, QuestionSurface } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { syncState, withNewer } from "./sync.ts";

const hubKey = ["questions", "hub"] as const;

/**
 * The questions the hub itself waits on you for (#976), oldest first. They show in the Inbox's
 * Needs you, in Home's tray and in the tray of the chat each one concerns. A read that lands after a
 * new sync generation began is taken again (ADR 013).
 */
const hubQuestionsQuery = queryOptions({
  queryKey: hubKey,
  queryFn: async ({ client }): Promise<ReadonlyArray<HubQuestion>> => {
    const state = syncState(client);
    for (;;) {
      const generation = state.generation;
      const read = await call((c) => c.questions.listHub());
      if (state.generation === generation) return read.questions;
    }
  },
  ...followsEvents,
});

/**
 * A hub question changed: it was raised, answered or withdrawn. The event carries the whole
 * question, so the list takes it at once: an open one stays, any other leaves. A read already on
 * its way may predate the change, so it is cancelled and the list read again.
 */
export const hubQuestionChanged = async (queryClient: QueryClient, question: HubQuestion): Promise<void> => {
  const take = () =>
    queryClient.setQueryData<ReadonlyArray<HubQuestion>>(hubKey, (old) =>
      withNewer(old, question, (kept) => kept.state === "open"),
    );
  take();
  if (queryClient.isFetching({ queryKey: hubKey, exact: true }) === 0) return;
  await queryClient.cancelQueries({ queryKey: hubKey, exact: true });
  take();
  await queryClient.invalidateQueries({ queryKey: hubKey, exact: true });
};

const NONE: ReadonlyArray<HubQuestion> = [];

/** The read of the hub's questions for you, with its loading and failure states. */
export const useHubQuestionsQuery = () => useQuery(hubQuestionsQuery);

/** The hub's questions for you, oldest first; none until read. */
export const useHubQuestions = (): ReadonlyArray<HubQuestion> => useHubQuestionsQuery().data ?? NONE;

/** Your answer to a hub question: the key of the choice you picked, or your own words (#1045). */
export type HubAnswerSent = { readonly picked: string } | { readonly answer: string };

/** Sends your answer to a hub question, saying `via` where you answered it; it leaves the list at once. */
export const useAnswerHubQuestion = (via: QuestionSurface) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ questionId, answer }: { questionId: HubQuestionId; answer: HubAnswerSent }) =>
      call((c) => c.questions.answerHub({ params: { hubQuestionId: questionId }, payload: { ...answer, via } })),
    onSuccess: (question) => void hubQuestionChanged(queryClient, question),
  });
};

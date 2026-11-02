import type { WaitingQuestion } from "@hobbots/api";
import { isTerminalTask, type NoteId, type Question, type QuestionId, type Task, type TaskId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { syncState } from "./sync.ts";
import { applyTaskEvent } from "./tasks.ts";

const waitingKey = ["questions", "waiting"] as const;

/**
 * The questions that climbed every lead and wait for you (ADR 018), oldest first, each with the
 * Task it asks about. They show in the Inbox's Needs you as well as on the card in the lead's chat.
 * A read that lands after a new sync generation began is taken again (ADR 013).
 */
export const waitingQuestionsQuery = queryOptions({
  queryKey: waitingKey,
  queryFn: async ({ client }): Promise<ReadonlyArray<WaitingQuestion>> => {
    const state = syncState(client);
    for (;;) {
      const generation = state.generation;
      const read = await call((c) => c.questions.list());
      if (state.generation === generation) return read.questions;
    }
  },
  ...followsEvents,
});

/**
 * Reads the list again after a change, so it shows what the hub has whatever order the event and
 * a pending read arrive in. A read already in flight may have been taken before the change, and
 * while the list has no data yet Query would hand that read back instead of starting another, so
 * it is cancelled first. `drop` takes questions out at once, before the new read answers.
 */
const readAgain = async (queryClient: QueryClient, drop?: (each: WaitingQuestion) => boolean) => {
  const dropNow = () => {
    if (drop === undefined) return;
    queryClient.setQueryData<ReadonlyArray<WaitingQuestion>>(waitingKey, (old) => old?.filter((each) => !drop(each)));
  };
  dropNow();
  await queryClient.cancelQueries({ queryKey: waitingKey, exact: true });
  // Cancelling a read puts back the list as it was before that read began.
  dropNow();
  await queryClient.invalidateQueries({ queryKey: waitingKey, exact: true });
};

/**
 * A question changed: it reached you, or was answered. A question that reaches you comes without
 * its Task, so the list is read again; one answered leaves the list at once. A question moving
 * from one lead to another never reaches you.
 */
export const questionChanged = (queryClient: QueryClient, question: Question): Promise<void> => {
  if (question.state === "answered") return readAgain(queryClient, (each) => each.question.id === question.id);
  return question.recipientId === null ? readAgain(queryClient) : Promise.resolve();
};

/**
 * Work that ended takes its questions out of your Inbox: nobody is left to hear the answer. The
 * list is read again only when it holds such a question or a read is on its way.
 */
export const workEnded = (queryClient: QueryClient, task: Task): Promise<void> => {
  if (!isTerminalTask(task.state)) return Promise.resolve();
  const about = (each: WaitingQuestion) => each.task.id === task.id || each.task.rootId === task.id;
  const reading = queryClient.isFetching({ queryKey: waitingKey, exact: true }) > 0;
  const holds = queryClient.getQueryData<ReadonlyArray<WaitingQuestion>>(waitingKey)?.some(about) ?? false;
  return reading || holds ? readAgain(queryClient, about) : Promise.resolve();
};

const NONE: ReadonlyArray<WaitingQuestion> = [];

/** The read of the questions waiting for you, with its loading and failure states. */
export const useWaitingQuestionsQuery = () => useQuery(waitingQuestionsQuery);

/** The questions waiting for you, oldest first; none until read. */
export const useWaitingQuestions = (): ReadonlyArray<WaitingQuestion> => useWaitingQuestionsQuery().data ?? NONE;

/** Sends your answer to a question that reached you; the card shows it at once, before its event. */
export const useAnswerQuestion = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ questionId, answer }: { questionId: QuestionId; answer: string }) =>
      call((c) => c.questions.answer({ params: { questionId }, payload: { answer } })),
    onSuccess: (question) => {
      applyTaskEvent(queryClient, { _tag: "QuestionAnswered", question });
      void questionChanged(queryClient, question);
    },
  });
};

/**
 * Leaves your note on a Task for its nearest lead (ADR 018). Each note is sent under a key of its
 * own, so sending it again after a lost reply never leaves it twice; the drawer shows it at once.
 */
export const useLeaveNote = (taskId: TaskId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, text }: { key: NoteId; text: string }) =>
      call((c) => c.questions.leaveNote({ params: { taskId }, payload: { key, text } })),
    onSuccess: (note) => applyTaskEvent(queryClient, { _tag: "NoteLeft", note }),
  });
};

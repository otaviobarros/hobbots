import type { WaitingQuestion } from "@hobbots/api";
import { isTerminalTask, type NoteId, type Question, type QuestionId, type Task, type TaskId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { applyTaskEvent } from "./tasks.ts";

const waitingKey = ["questions", "waiting"] as const;

/**
 * The questions that climbed every lead and wait for you (ADR 018), oldest first, each with the
 * Task it asks about. They show in the Inbox's Needs you as well as on the card in the lead's chat.
 */
const waitingQuestionsQuery = queryOptions({
  queryKey: waitingKey,
  queryFn: () => call((c) => c.questions.list()).then((read) => read.questions),
  ...followsEvents,
});

/**
 * A question changed: it reached you, or was answered. The list is read again, since a question
 * that reaches you comes without its Task, and a read on its way may predate the change; one
 * answered leaves the list at once. A question moving from one lead to another never reaches you.
 */
export const questionChanged = (queryClient: QueryClient, question: Question) => {
  if (question.state === "answered") {
    queryClient.setQueryData<ReadonlyArray<WaitingQuestion>>(waitingKey, (old) =>
      old?.filter((each) => each.question.id !== question.id),
    );
  } else if (question.recipientId !== null) return;
  void queryClient.invalidateQueries({ queryKey: waitingKey, exact: true });
};

/** Work that ended takes its questions out of your Inbox: nobody is left to hear the answer. */
export const workEnded = (queryClient: QueryClient, task: Task) => {
  if (!isTerminalTask(task.state)) return;
  queryClient.setQueryData<ReadonlyArray<WaitingQuestion>>(waitingKey, (old) =>
    old?.filter((each) => each.task.id !== task.id && each.task.rootId !== task.id),
  );
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
      questionChanged(queryClient, question);
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

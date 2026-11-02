import { NoteRefused, QuestionClosed, QuestionNotFound, TaskNotFound, UserSession } from "@hobbots/api";
import type { NoteId, Question, QuestionId, TaskId, TaskNote } from "@hobbots/domain";
import { Context, DateTime, Effect, Layer } from "effect";
import { EventPublisher } from "./ports.ts";
import { TaskRepository, type WaitingQuestion } from "./tasks.ts";

/**
 * What you say about a Quest's work (ADR 018). You talk only to the lead: questions that reached
 * you because no lead could answer them, and notes you leave on a Task for its lead.
 */
export class QuestionService extends Context.Service<
  QuestionService,
  {
    /** The questions that climbed every lead and wait for you, oldest first. */
    readonly listWaiting: Effect.Effect<ReadonlyArray<WaitingQuestion>>;
    /**
     * Records your answer to a question waiting for you. Only the user answers here (PE-006): it
     * needs a `UserSession`, which no hob, Charm or runtime tool has.
     */
    readonly answer: (
      questionId: QuestionId,
      answer: string,
    ) => Effect.Effect<Question, QuestionNotFound | QuestionClosed, UserSession>;
    /**
     * Leaves your note on a Task for its nearest lead, as a message about that Task. `key` is the
     * command's idempotency key: the same note sent again changes nothing. User sessions only.
     */
    readonly leaveNote: (
      taskId: TaskId,
      key: NoteId,
      text: string,
    ) => Effect.Effect<TaskNote, TaskNotFound | NoteRefused, UserSession>;
  }
>()("@hobbots/agents/QuestionService") {
  static readonly layer = Layer.effect(
    QuestionService,
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const bus = yield* EventPublisher;
      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
      return QuestionService.of({
        listWaiting: tasks.listWaitingQuestions,
        answer: (questionId, answer) =>
          Effect.gen(function* () {
            yield* UserSession;
            const committed = yield* tasks
              .answerQuestion(questionId, { _tag: "User" }, answer, yield* nowIso)
              .pipe(
                Effect.catchTag("TaskRefused", (refused) =>
                  Effect.fail(
                    refused.reason === "question-missing"
                      ? new QuestionNotFound({ questionId })
                      : new QuestionClosed({ questionId }),
                  ),
                ),
              );
            yield* bus.publish(committed.entries);
            return committed.value;
          }),
        leaveNote: (taskId, key, text) =>
          Effect.gen(function* () {
            yield* UserSession;
            const committed = yield* tasks.leaveNote({ id: key, taskId, text, createdAt: yield* nowIso }).pipe(
              Effect.catchTag("TaskRefused", (refused) =>
                Effect.fail(
                  refused.reason === "task-missing"
                    ? new TaskNotFound({ taskId })
                    : new NoteRefused({
                        taskId,
                        reason: refused.reason === "note-key-reused" ? "key-reused" : "task-ended",
                      }),
                ),
              ),
            );
            yield* bus.publish(committed.entries);
            return committed.value;
          }),
      });
    }),
  );
}

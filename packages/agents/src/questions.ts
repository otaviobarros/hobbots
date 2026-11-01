import { QuestionClosed, QuestionNotFound, UserSession } from "@hobbots/api";
import type { Question, QuestionId } from "@hobbots/domain";
import { Context, DateTime, Effect, Layer } from "effect";
import { EventPublisher } from "./ports.ts";
import { TaskRepository } from "./tasks.ts";

/** Questions that reached you because no lead could answer them (ADR 018). */
export class QuestionService extends Context.Service<
  QuestionService,
  {
    /**
     * Records your answer to a question waiting for you. Only the user answers here (PE-006): it
     * needs a `UserSession`, which no hob, Charm or runtime tool has.
     */
    readonly answer: (
      questionId: QuestionId,
      answer: string,
    ) => Effect.Effect<Question, QuestionNotFound | QuestionClosed, UserSession>;
  }
>()("@hobbots/agents/QuestionService") {
  static readonly layer = Layer.effect(
    QuestionService,
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const bus = yield* EventPublisher;
      return QuestionService.of({
        answer: (questionId, answer) =>
          Effect.gen(function* () {
            yield* UserSession;
            const at = DateTime.formatIso(yield* DateTime.now);
            const committed = yield* tasks
              .answerQuestion(questionId, { _tag: "User" }, answer, at)
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
      });
    }),
  );
}

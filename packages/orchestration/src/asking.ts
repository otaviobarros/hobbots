import type { TaskRepository } from "@hobbots/agents";
import {
  CheckpointId,
  MilestoneId,
  type Question,
  QuestionId,
  type TaskToolInput,
  type TaskToolRefused,
} from "@hobbots/domain";
import { Effect } from "effect";
import { type CallScope, fromRecords, journalOf, newId, ownTask, refuse } from "./call-scope.ts";

interface Deps {
  readonly tasks: TaskRepository["Service"];
}

/** A question asked in the call's tree. */
const questionIn = (scope: CallScope, id: string): Effect.Effect<Question, TaskToolRefused> => {
  const question = scope.tree.questions.find((each) => each.id === id);
  return question === undefined
    ? refuse("question-missing", `No question ${id} in the work you are on.`)
    : Effect.succeed(question);
};

const recipient = (question: Question) => (question.recipientId === null ? "the user" : `hob ${question.recipientId}`);

/** Tools that report where a Task stands and move questions up the chain of leads. */
export const makeAsking = ({ tasks }: Deps) => ({
  report_checkpoint: (scope: CallScope, input: Omit<TaskToolInput<"report_checkpoint">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      const journal = journalOf();
      const checkpoint = journal.keep(
        yield* fromRecords(
          tasks.recordCheckpoint({
            id: CheckpointId.make(newId()),
            taskId: task.id,
            source: input.kind === "milestone" ? "planned" : "unplanned",
            kind: input.kind,
            milestoneId: input.milestone_id === undefined ? null : MilestoneId.make(input.milestone_id),
            summary: input.summary,
            createdAt: scope.at,
          }),
        ),
      );
      return {
        done: { message: `Recorded a ${input.kind} on Task ${task.id}.`, details: { checkpoint_id: checkpoint.id } },
        entries: journal.entries,
      };
    }),

  ask: (scope: CallScope, input: Omit<TaskToolInput<"ask">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      const journal = journalOf();
      const question = journal.keep(
        yield* fromRecords(
          tasks.askQuestion({
            id: QuestionId.make(newId()),
            taskId: task.id,
            askerId: scope.caller.agentId,
            text: input.question,
            createdAt: scope.at,
          }),
        ),
      );
      return {
        done: {
          message: `Asked ${recipient(question)}. The answer comes back to you.`,
          details: { question_id: question.id, recipient: question.recipientId },
        },
        entries: journal.entries,
      };
    }),

  answer: (scope: CallScope, input: Omit<TaskToolInput<"answer">, "key">) =>
    Effect.gen(function* () {
      const asked = yield* questionIn(scope, input.question_id);
      const journal = journalOf();
      journal.keep(
        yield* fromRecords(
          tasks.answerQuestion(asked.id, { _tag: "Lead", agentId: scope.caller.agentId }, input.answer, scope.at),
        ),
      );
      return {
        done: { message: `Answered; it goes back to hob ${asked.askerId}.`, details: { question_id: asked.id } },
        entries: journal.entries,
      };
    }),

  escalate: (scope: CallScope, input: Omit<TaskToolInput<"escalate">, "key">) =>
    Effect.gen(function* () {
      const asked = yield* questionIn(scope, input.question_id);
      const journal = journalOf();
      const question = journal.keep(yield* fromRecords(tasks.escalateQuestion(asked.id, scope.caller.agentId)));
      return {
        done: {
          message: `Passed the question to ${recipient(question)}.`,
          details: { question_id: question.id, recipient: question.recipientId },
        },
        entries: journal.entries,
      };
    }),
});

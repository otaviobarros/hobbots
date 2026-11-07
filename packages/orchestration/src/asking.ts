import type { HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  AgentId,
  CheckpointId,
  MilestoneId,
  type Question,
  QuestionId,
  type TaskToolInput,
  type TaskToolRefused,
} from "@hobbots/domain";
import { Effect } from "effect";
import { type CallScope, fromRecords, journalOf, newId, ownTask, refuse, taskIn } from "./call-scope.ts";

interface Deps {
  readonly tasks: TaskRepository["Service"];
  readonly hobs: HobbotsRepository["Service"];
}

/** A question asked on a Task the turn reaches. */
const questionIn = (scope: CallScope, id: string): Effect.Effect<Question, TaskToolRefused> => {
  const question = scope.tree.questions.find((each) => each.id === id);
  return question === undefined
    ? refuse("question-missing", `No question ${id} in the work you are on.`)
    : Effect.as(taskIn(scope, question.taskId), question);
};

const recipient = (question: Question) => (question.recipientId === null ? "the user" : `hob ${question.recipientId}`);

/**
 * The hob a milestone report names as having done the work (#743), by id or name: one that owns a Task
 * in this work, so a report never credits a hob outside it. Null when the report names none, or the
 * caller itself.
 */
const reacherOf = (
  hobs: Deps["hobs"],
  scope: CallScope,
  input: Omit<TaskToolInput<"report_checkpoint">, "key">,
): Effect.Effect<AgentId | null, TaskToolRefused> =>
  Effect.gen(function* () {
    const named = input.reached_by;
    if (named === undefined) return null;
    if (input.kind !== "milestone") {
      return yield* refuse("milestone-mismatch", "Only a milestone checkpoint names the hob that reached it.");
    }
    const owners = new Set<string>(scope.tree.tasks.map((task) => task.ownerId));
    const wanted = named.trim().toLowerCase();
    const hob = owners.has(named)
      ? named
      : (yield* hobs.listAgents).find((agent) => owners.has(agent.id) && agent.name.trim().toLowerCase() === wanted)
          ?.id;
    if (hob === undefined) {
      return yield* refuse(
        "hob-missing",
        `No hob named ${named} has a Task in this work. Name the hob whose work reached the milestone, or leave reached_by out when your own work did.`,
      );
    }
    return hob === scope.caller.agentId ? null : AgentId.make(hob);
  });

/** Tools that report where a Task stands and move questions up the chain of leads. */
export const makeAsking = ({ tasks, hobs }: Deps) => ({
  report_checkpoint: (scope: CallScope, input: Omit<TaskToolInput<"report_checkpoint">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      const reachedBy = yield* reacherOf(hobs, scope, input);
      const journal = journalOf();
      const checkpoint = journal.keep(
        yield* fromRecords(
          tasks.recordCheckpoint({
            id: CheckpointId.make(newId()),
            taskId: task.id,
            source: input.kind === "milestone" ? "planned" : "unplanned",
            kind: input.kind,
            milestoneId: input.milestone_id === undefined ? null : MilestoneId.make(input.milestone_id),
            reachedBy,
            summary: input.summary,
            detail: input.detail ?? null,
            createdAt: scope.at,
          }),
        ),
      );
      return {
        done: {
          message: `Recorded a ${input.kind} on Task ${task.id}${reachedBy === null ? "" : `, reached by hob ${reachedBy}`}.`,
          details: { checkpoint_id: checkpoint.id, ...(reachedBy === null ? {} : { reached_by: reachedBy }) },
        },
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
            ...(input.options === undefined ? {} : { options: input.options }),
            // The tool counts choices from 1; the record keeps the index.
            ...(input.recommended === undefined ? {} : { recommended: input.recommended - 1 }),
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

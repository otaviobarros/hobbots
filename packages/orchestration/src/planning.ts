import type { TaskRepository } from "@hobbots/agents";
import {
  ArtifactId,
  cancelMoves,
  descendantsOf,
  isTerminalTask,
  MilestoneId,
  QuestId,
  type Task,
  TaskId,
  type TaskState,
  type TaskToolInput,
  type TaskToolRefused,
} from "@hobbots/domain";
import { Effect } from "effect";
import {
  type CallScope,
  fromRecords,
  journalOf,
  ledTask,
  newId,
  ownTask,
  questLimitsFor,
  refuse,
  type TaskToolLimits,
} from "./call-scope.ts";

interface Deps {
  readonly tasks: TaskRepository["Service"];
  readonly capacity: (
    scope: CallScope,
    ownerId: Task["ownerId"],
    adding: number,
  ) => Effect.Effect<void, TaskToolRefused>;
  readonly limits: TaskToolLimits;
}

const newMilestones = (titles: ReadonlyArray<string> | undefined) =>
  (titles ?? []).map((title) => ({ id: MilestoneId.make(newId()), title }));

/**
 * Tools a Task's owner runs its own work with: steps, a Quest, waits, the result, and cancelling
 * work under it.
 */
export const makePlanning = ({ tasks, capacity, limits }: Deps) => ({
  plan_steps: (scope: CallScope, input: Omit<TaskToolInput<"plan_steps">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      // Created at the same moment, the steps list by id: sorted ids keep them in the order planned.
      const ids = input.steps
        .map(() => newId())
        .sort()
        .map((id) => TaskId.make(id));
      const early = input.steps.findIndex((step, index) => (step.after ?? []).some((n) => n > index));
      if (early !== -1) {
        return yield* refuse("invalid-input", `Step ${early + 1} can only come after steps before it.`);
      }
      yield* capacity(scope, scope.caller.agentId, ids.length);
      const journal = journalOf();
      const steps = [];
      for (const [index, step] of input.steps.entries()) {
        const milestones = newMilestones(step.milestones);
        journal.keep(
          yield* fromRecords(
            tasks.createTask({
              task: {
                id: ids[index] as TaskId,
                ownerId: scope.caller.agentId,
                parentId: task.id,
                threadId: null,
                brief: step.brief,
                dependsOn: (step.after ?? []).map((n) => ids[n - 1] as TaskId),
                createdAt: scope.at,
              },
              delegation: null,
              milestones,
            }),
          ),
        );
        steps.push({ task_id: ids[index] as string, milestones: milestones.map((m) => m.id as string) });
      }
      return {
        done: { message: `Planned ${steps.length} steps under Task ${task.id}.`, details: { steps } },
        entries: journal.entries,
      };
    }),

  start_quest: (scope: CallScope, input: Omit<TaskToolInput<"start_quest">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      const quest = yield* questLimitsFor(scope, limits, task, input);
      const journal = journalOf();
      const started = journal.keep(
        yield* fromRecords(
          tasks.startQuest({
            id: QuestId.make(newId()),
            taskId: task.id,
            goal: input.goal,
            acceptance: input.acceptance ?? [],
            limits: quest,
            createdAt: scope.at,
          }),
        ),
      );
      return {
        done: {
          message: `Task ${task.id} is now a Quest. You lead it.`,
          details: { quest_id: started.id, depth: started.depth, max_depth: quest.maxDepth, deadline: quest.deadline },
        },
        entries: journal.entries,
      };
    }),

  wait_for: (scope: CallScope, input: Omit<TaskToolInput<"wait_for">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      const under = new Map(descendantsOf(task, scope.tree.tasks).map((each) => [each.id as string, each]));
      const outside = input.tasks.filter((id) => !under.has(id));
      if (outside.length > 0) {
        return yield* refuse("wait-outside-subtree", `These are not under Task ${task.id}: ${outside.join(", ")}.`);
      }
      const mode = input.mode ?? "all";
      const states = Object.fromEntries(input.tasks.map((id) => [id, under.get(id)?.state ?? "missing"]));
      const ended = input.tasks.filter((id) => isTerminalTask(under.get(id)?.state as TaskState));
      if (mode === "any" ? ended.length > 0 : ended.length === input.tasks.length) {
        return { done: { message: "Nothing to wait for: they have already ended.", details: { states } }, entries: [] };
      }
      const journal = journalOf();
      journal.keep(
        yield* fromRecords(
          tasks.waitFor(task.id, task.revision, {
            on: input.tasks.map((id) => TaskId.make(id)),
            mode,
            at: scope.at,
          }),
        ),
      );
      return {
        done: {
          message: `Task ${task.id} is waiting for ${mode === "any" ? "any" : "all"} of them. You can keep working meanwhile.`,
          details: { states },
        },
        entries: journal.entries,
      };
    }),

  complete_task: (scope: CallScope, input: Omit<TaskToolInput<"complete_task">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      if (task.currentAttemptId === null) {
        return yield* refuse("no-attempt", `Task ${task.id} has not started, so it has no result yet.`);
      }
      const artifacts = (input.artifacts ?? []).map((artifact) => ({ ...artifact, id: ArtifactId.make(newId()) }));
      const journal = journalOf();
      journal.keep(
        yield* fromRecords(
          tasks.completeTask(task.id, task.revision, {
            summary: input.summary,
            attemptId: task.currentAttemptId,
            artifacts,
            at: scope.at,
            carried: scope.caller.carried ?? [],
          }),
        ),
      );
      return {
        done: {
          message: `Task ${task.id} is complete.`,
          details: { artifacts: artifacts.map((artifact) => artifact.id as string) },
        },
        entries: journal.entries,
      };
    }),

  cancel_task: (scope: CallScope, input: Omit<TaskToolInput<"cancel_task">, "key">) =>
    Effect.gen(function* () {
      const target = yield* ledTask(scope, input.task_id);
      const journal = journalOf();
      const moves = cancelMoves(target, scope.tree);
      for (const { task, to } of moves) {
        journal.keep(yield* fromRecords(tasks.moveTask(task.id, task.revision, to, scope.at)));
      }
      const cancelling = moves.filter((move) => move.to === "cancelling").map((move) => move.task.id as string);
      return {
        done: {
          message:
            cancelling.length === 0
              ? `Task ${target.id} is cancelled.`
              : `Cancel requested for Task ${target.id}; Hobbots confirms each Task as it stops.`,
          details: {
            cancelled: moves.filter((move) => move.to === "cancelled").map((move) => move.task.id as string),
            cancelling,
          },
        },
        entries: journal.entries,
      };
    }),
});

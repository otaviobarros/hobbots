import type { TaskRepository } from "@hobbots/agents";
import {
  ArtifactId,
  ancestorsOf,
  descendantsOf,
  isLiveAttempt,
  isTerminalTask,
  MilestoneId,
  QuestId,
  type Task,
  TaskId,
  type TaskState,
  type TaskToolInput,
  type TaskToolRefused,
} from "@hobbots/domain";
import { DateTime, Effect } from "effect";
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

/** The Tasks under `task` that a cancel moves, deepest first, so a Task ends only after what is under it. */
const deepestFirst = (task: Task, tree: ReadonlyArray<Task>) =>
  [task, ...descendantsOf(task, tree)]
    .map((each) => ({ each, depth: ancestorsOf(each, tree).length }))
    .sort((a, b) => b.depth - a.depth)
    .map(({ each }) => each);

/**
 * Tools a Task's owner runs its own work with: steps, a Quest, waits, the result, and cancelling
 * work under it.
 */
export const makePlanning = ({ tasks, capacity, limits }: Deps) => ({
  plan_steps: (scope: CallScope, input: Omit<TaskToolInput<"plan_steps">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      const ids = input.steps.map(() => TaskId.make(newId()));
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
                // A millisecond apart, so the tree lists the steps in the order they were planned.
                createdAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(scope.at), { milliseconds: index })),
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
      const tree = scope.tree.tasks;
      const live = new Set(scope.tree.attempts.filter((a) => isLiveAttempt(a.state)).map((a) => a.id as string));
      const states = new Map(tree.map((each) => [each.id, each.state]));
      const journal = journalOf();
      const cancelled: Array<string> = [];
      const cancelling: Array<string> = [];
      for (const task of deepestFirst(target, tree)) {
        const state = states.get(task.id) as TaskState;
        if (isTerminalTask(state) || state === "cancelling") continue;
        // Nothing runs in a queued Task with nothing open under it, so its cancel is confirmed at once.
        const quiet =
          state === "queued" &&
          (task.currentAttemptId === null || !live.has(task.currentAttemptId)) &&
          descendantsOf(task, tree).every((each) => isTerminalTask(states.get(each.id) as TaskState));
        const to = quiet ? "cancelled" : "cancelling";
        journal.keep(yield* fromRecords(tasks.moveTask(task.id, task.revision, to, scope.at)));
        states.set(task.id, to);
        (quiet ? cancelled : cancelling).push(task.id);
      }
      return {
        done: {
          message:
            cancelling.length === 0
              ? `Task ${target.id} is cancelled.`
              : `Cancel requested for Task ${target.id}; Hobbots confirms each Task as it stops.`,
          details: { cancelled, cancelling },
        },
        entries: journal.entries,
      };
    }),
});

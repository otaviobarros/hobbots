import type { TaskRepository } from "@hobbots/agents";
import {
  ArtifactId,
  cancelMoves,
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
import { Effect } from "effect";
import {
  type CallScope,
  fromRecords,
  journalOf,
  ledTask,
  nameFor,
  newId,
  ownTask,
  questLimitsFor,
  refuse,
  type TaskToolLimits,
} from "./call-scope.ts";
import type { WrapUp } from "./wrap-up.ts";

interface Deps {
  readonly tasks: TaskRepository["Service"];
  readonly capacity: (
    scope: CallScope,
    ownerId: Task["ownerId"],
    adding: number,
  ) => Effect.Effect<void, TaskToolRefused>;
  readonly limits: TaskToolLimits;
  /** What the Task leaves uncommitted in its folders, read as it completes (#586). */
  readonly wrapUp: (task: Task) => Effect.Effect<WrapUp>;
}

/**
 * What a hob reads after it waits. wait_for does not block, so a hob told it may keep working calls
 * it again and again to check (#572); it ends its turn instead, and the hub wakes it.
 */
const END_TURN =
  "End your turn now. Hobbots wakes you when they end, or sooner when something arrives for you, such as a question. Calling wait_for again only to check changes nothing.";

/**
 * What the awaited Tasks, or Tasks under them, hold open: the questions that wait on an answer, and
 * the blockers of those that are blocked or last reported one. A hob that waits on a Task that asked it something answers
 * instead of waiting on itself (#573).
 */
const openOnAwaited = (scope: CallScope, awaited: ReadonlyArray<Task>) => {
  const within = new Set<string>(
    awaited.flatMap((each) => [each.id, ...descendantsOf(each, scope.tree.tasks).map((under) => under.id)]),
  );
  const questions = scope.tree.questions
    .filter((question) => question.state === "open" && within.has(question.taskId))
    .map((question) => ({
      question_id: question.id as string,
      task_id: question.taskId as string,
      asker: question.askerId as string,
      question: question.text,
      waits_for: nameFor(question.recipientId, scope.caller.agentId),
    }));
  // A Task is blocked, or the last thing its hob reported about it is a blocker.
  const blockers = awaited.flatMap((each) => {
    const reported = scope.tree.checkpoints
      .filter((checkpoint) => checkpoint.taskId === each.id && checkpoint.source !== "automatic")
      .toSorted((a, b) => b.revision - a.revision)[0];
    const latest = reported?.kind === "blocker" ? reported.summary : null;
    if (isTerminalTask(each.state) || (each.state !== "blocked" && latest === null)) return [];
    return [{ task_id: each.id as string, blocker: latest ?? "Blocked, with no reason reported." }];
  });
  return { questions, blockers };
};

/** What the hob does after a wait: answer what waits on it, then end its turn. */
const afterWaiting = (open: ReturnType<typeof openOnAwaited>) => {
  const yours = open.questions.filter((question) => question.waits_for === "you").length;
  const blocked = open.blockers.length;
  return [
    ...(yours === 0
      ? []
      : [
          `${yours === 1 ? "A question from them waits" : `${yours} questions from them wait`} for you: answer each with answer, or pass it up with escalate, before you end your turn.`,
        ]),
    ...(blocked === 0 ? [] : [`${blocked === 1 ? "One of them is" : `${blocked} of them are`} blocked: see blockers.`]),
    END_TURN,
  ].join(" ");
};

/** The questions and blockers in a wait's details, only when there are any. */
const openDetails = (open: ReturnType<typeof openOnAwaited>) => ({
  ...(open.questions.length === 0 ? {} : { questions: open.questions }),
  ...(open.blockers.length === 0 ? {} : { blockers: open.blockers }),
});

const sameTasks = (recorded: ReadonlyArray<string>, asked: ReadonlyArray<string>) => {
  const wanted = new Set(asked);
  return recorded.length === wanted.size && recorded.every((id) => wanted.has(id));
};

const newMilestones = (titles: ReadonlyArray<string> | undefined) =>
  (titles ?? []).map((title) => ({ id: MilestoneId.make(newId()), title }));

/**
 * Tools a Task's owner runs its own work with: steps, a Quest, waits, the result, and cancelling
 * work under it.
 */
export const makePlanning = ({ tasks, capacity, limits, wrapUp }: Deps) => ({
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
      const open = openOnAwaited(
        scope,
        input.tasks.flatMap((id) => under.get(id) ?? []),
      );
      const details = { states, ...openDetails(open) };
      const recorded = scope.tree.waits.find((wait) => wait.taskId === task.id);
      if (recorded !== undefined && recorded.mode === mode && sameTasks(recorded.on, input.tasks)) {
        return {
          done: { message: `Task ${task.id} already waits for these. ${afterWaiting(open)}`, details },
          entries: [],
        };
      }
      // The turn making the call still runs: the Task shows waiting once it ends (#572).
      const turnRunning =
        task.state === "active" &&
        scope.tree.attempts.some((each) => each.id === task.currentAttemptId && isLiveAttempt(each.state));
      const journal = journalOf();
      journal.keep(
        yield* fromRecords(
          tasks.waitFor(task.id, task.revision, {
            on: input.tasks.map((id) => TaskId.make(id)),
            mode,
            at: scope.at,
            keepActive: turnRunning,
          }),
        ),
      );
      return {
        done: {
          message: `Task ${task.id} waits for ${mode === "any" ? "any" : "all"} of them. ${afterWaiting(open)}`,
          details,
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
      const left = yield* wrapUp(task);
      const journal = journalOf();
      journal.keep(
        yield* fromRecords(
          tasks.completeTask(task.id, task.revision, {
            summary: input.summary,
            attemptId: task.currentAttemptId,
            artifacts,
            at: scope.at,
            carried: scope.caller.carried ?? [],
            ...(left.uncommitted === undefined ? {} : { uncommitted: left.uncommitted }),
          }),
        ),
      );
      return {
        done: {
          message:
            left.warning === null ? `Task ${task.id} is complete.` : `Task ${task.id} is complete. ${left.warning}`,
          details: {
            artifacts: artifacts.map((artifact) => artifact.id as string),
            ...(left.uncommitted === undefined ? {} : { uncommitted: left.uncommitted.summary }),
          },
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

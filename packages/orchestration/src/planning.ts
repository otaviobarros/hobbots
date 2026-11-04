import type { FolderChecksShape, TaskRepository } from "@hobbots/agents";
import {
  ArtifactId,
  type AttemptId,
  cancelMoves,
  descendantsOf,
  isTerminalTask,
  liveAttemptOn,
  MilestoneId,
  pendingApprovals,
  QuestId,
  reportsOn,
  type Task,
  TaskId,
  TaskReadiness,
  type TaskState,
  type TaskToolInput,
  type TaskToolRefused,
  type TaskWait,
} from "@hobbots/domain";
import { Effect } from "effect";
import type { Authority, PathSeparator } from "./authority.ts";
import { cut, planNote } from "./briefs.ts";
import {
  approvalsWaiting,
  type CallScope,
  describeApproval,
  fromRecords,
  journalOf,
  ledTask,
  nameFor,
  newId,
  outcomesShown,
  ownTask,
  questLimitsFor,
  refuse,
  type TaskToolLimits,
} from "./call-scope.ts";
import { namedFolders, requestedFolders, withFolders } from "./default-folders.ts";
import type { WrapUp, WrapUpPolicy } from "./wrap-up.ts";

/** Longest reason a lead's `leave_uncommitted` keeps on the Task (#665). */
const REASON_LIMIT = 600;

interface Deps {
  readonly tasks: TaskRepository["Service"];
  readonly capacity: (
    scope: CallScope,
    ownerId: Task["ownerId"],
    adding: number,
  ) => Effect.Effect<void, TaskToolRefused>;
  readonly limits: TaskToolLimits;
  /** What the Task leaves uncommitted in its folders, read as it completes (#586). */
  readonly wrapUp: (task: Task, attempts: ReadonlyArray<AttemptId>, policy: WrapUpPolicy) => Effect.Effect<WrapUp>;
  readonly folderChecks: FolderChecksShape;
  /** The caller's authority on a Task: its own, narrowed by every Delegation on the way down. */
  readonly authority: (scope: CallScope, task: Task) => Effect.Effect<Authority>;
  readonly separator: PathSeparator;
}

/**
 * What a hob reads after it waits. wait_for does not block, so a hob told it may keep working calls
 * it again and again to check (#572); it ends its turn instead, and the hub wakes it.
 */
const END_TURN =
  "End your turn now. Hobbots wakes you when they end, or sooner when something arrives for you, such as a question. Calling wait_for again only to check changes nothing.";

/**
 * What the awaited Tasks, or Tasks under them, hold open: the questions that wait on an answer, the
 * actions that wait for the user's approval (#698), and the blockers of those that are blocked or
 * last reported one. A hob that waits on a Task that asked it something answers instead of waiting
 * on itself (#573).
 */
const openOnAwaited = (scope: CallScope, awaited: ReadonlyArray<Task>) => {
  const within = new Set<TaskId>(
    awaited.flatMap((each) => [each.id, ...descendantsOf(each, scope.tree.tasks).map((under) => under.id)]),
  );
  const approvals = pendingApprovals(scope.tree)
    .filter((approval) => within.has(approval.taskId))
    .map((approval) => ({ task_id: approval.taskId as string, ...describeApproval(approval) }));
  const questions = scope.tree.questions
    .filter((question) => question.state === "open" && within.has(question.taskId))
    .map((question) => ({
      question_id: question.id as string,
      task_id: question.taskId as string,
      asker: question.askerId as string,
      question: question.text,
      waits_for: nameFor(question.recipientId, scope.caller.agentId),
    }));
  // A Task is blocked, the last thing its hob reported about it is a blocker, or it cannot start
  // until someone acts on a Task it comes after (#667).
  const blockers = awaited.flatMap((each) => {
    const reported = scope.tree.checkpoints
      .filter((checkpoint) => checkpoint.taskId === each.id && reportsOn(checkpoint))
      .toSorted((a, b) => b.revision - a.revision)[0];
    const latest = reported?.kind === "blocker" ? reported.summary : null;
    if (isTerminalTask(each.state)) return [];
    if (each.state === "blocked" || latest !== null) {
      return [{ task_id: each.id as string, blocker: latest ?? "Blocked, with no reason reported." }];
    }
    const ready = TaskReadiness.of(each, scope.tree.tasks);
    if (ready._tag !== "Blocked") return [];
    return [
      {
        task_id: each.id as string,
        blocker: `It cannot start until someone acts on ${ready.by.map((id) => `Task ${id}`).join(", ")}, which it comes after and which did not complete.`,
      },
    ];
  });
  return { questions, approvals, blockers };
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
    ...(open.approvals.length === 0 ? [] : [approvalsWaiting(open.approvals.length)]),
    END_TURN,
  ].join(" ");
};

/** The questions, approvals and blockers in a wait's details, only when there are any. */
const openDetails = (open: ReturnType<typeof openOnAwaited>) => ({
  ...(open.questions.length === 0 ? {} : { questions: open.questions }),
  ...(open.approvals.length === 0 ? {} : { approvals: open.approvals }),
  ...(open.blockers.length === 0 ? {} : { blockers: open.blockers }),
});

/**
 * Whether a wait asks again for what `recorded` already waits for: the same Tasks of those still
 * open, so asking again after one of them ended, with or without it, changes nothing (#702).
 */
const sameWait = (
  recorded: TaskWait,
  asked: ReadonlyArray<string>,
  mode: TaskWait["mode"],
  ended: (id: string) => boolean,
) => {
  const open = (ids: ReadonlyArray<string>) => new Set(ids.filter((id) => !ended(id)));
  const [was, now] = [open(recorded.on), open(asked)];
  return recorded.mode === mode && was.size === now.size && [...was].every((id) => now.has(id));
};

/**
 * Why `wait_for` refuses ids that are not Tasks under the caller's: it takes Task ids, and a question's
 * id names the Task the question is about, which the hob waits on instead, or not at all when it is
 * its own, since the hub wakes it with the answer (#702).
 */
const outsideMessage = (
  scope: CallScope,
  task: Task,
  under: ReadonlyMap<string, Task>,
  outside: ReadonlyArray<string>,
) => {
  const questions = outside.flatMap((id) => {
    const question = scope.tree.questions.find((each) => each.id === id);
    if (question === undefined) return [];
    if (question.taskId === task.id) {
      return [
        `${id} is your own question about Task ${task.id}: you need not wait for it, since Hobbots wakes you with the answer.`,
      ];
    }
    return [
      under.has(question.taskId)
        ? `${id} is a question about Task ${question.taskId}: wait for that Task instead.`
        : `${id} is a question about Task ${question.taskId}, which is not under yours either: answer it with answer if it waits for you.`,
    ];
  });
  return [
    `wait_for takes the ids of Tasks under Task ${task.id}, and these are not: ${outside.join(", ")}.`,
    ...questions,
  ].join(" ");
};

const newMilestones = (titles: ReadonlyArray<string> | undefined) =>
  (titles ?? []).map((title) => ({ id: MilestoneId.make(newId()), title }));

/**
 * Tools a Task's owner runs its own work with: steps, a Quest, waits, the result, and cancelling
 * work under it.
 */
export const makePlanning = ({ tasks, capacity, limits, wrapUp, folderChecks, authority, separator }: Deps) => ({
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
        done: { message: `Planned ${steps.length} steps under Task ${task.id}.${planNote(task)}`, details: { steps } },
        entries: journal.entries,
      };
    }),

  start_quest: (scope: CallScope, input: Omit<TaskToolInput<"start_quest">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      const quest = yield* questLimitsFor(scope, limits, task, input);
      // Its work is in the folders the lead names, else those its brief and goal name (#670).
      const lead = (yield* authority(scope, task)).folders;
      const folders =
        input.folders === undefined
          ? yield* namedFolders(
              folderChecks,
              lead,
              [task.brief, input.goal, ...(input.acceptance ?? [])].join("\n"),
              separator,
            )
          : yield* requestedFolders(folderChecks, lead, input.folders, separator);
      const journal = journalOf();
      const started = journal.keep(
        yield* fromRecords(
          tasks.startQuest({
            id: QuestId.make(newId()),
            taskId: task.id,
            goal: input.goal,
            acceptance: input.acceptance ?? [],
            limits: withFolders(quest, folders),
            createdAt: scope.at,
          }),
        ),
      );
      return {
        done: {
          message: `Task ${task.id} is now a Quest. You lead it.${planNote(task)}`,
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
        return yield* refuse("wait-outside-subtree", outsideMessage(scope, task, under, outside));
      }
      const mode = input.mode ?? "all";
      const states = Object.fromEntries(input.tasks.map((id) => [id, under.get(id)?.state ?? "missing"]));
      const hasEnded = (id: string) => isTerminalTask(under.get(id)?.state as TaskState);
      const ended = input.tasks.filter(hasEnded);
      if (mode === "any" ? ended.length > 0 : ended.length === input.tasks.length) {
        return { done: { message: "Nothing to wait for: they have already ended.", details: { states } }, entries: [] };
      }
      const open = openOnAwaited(
        scope,
        input.tasks.flatMap((id) => under.get(id) ?? []),
      );
      const details = { states, ...openDetails(open) };
      const recorded = scope.tree.waits.find((wait) => wait.taskId === task.id);
      if (recorded !== undefined && sameWait(recorded, input.tasks, mode, hasEnded)) {
        return {
          done: { message: `Task ${task.id} already waits for these. ${afterWaiting(open)}`, details },
          entries: [],
        };
      }
      // The turn making the call still runs: the Task shows waiting once it ends (#572).
      const turnRunning = task.state === "active" && liveAttemptOn(task, scope.tree);
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
      // The Quest's own result is the user's, so its lead commits what it changed or says why not (#665).
      const attempts = scope.tree.attempts.filter((each) => each.taskId === task.id).map((each) => each.id);
      const left = yield* wrapUp(task, attempts, {
        hold: task.parentId === null && scope.tree.quests.some((quest) => quest.taskId === task.id),
        // A blank reason is none; a long one is cut, as every text the Summary shows is.
        reason: input.leave_uncommitted?.trim() ? cut(input.leave_uncommitted, REASON_LIMIT) : undefined,
      });
      if (left.held !== null) return yield* refuse("uncommitted-changes", left.held);
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
      const moved: Array<Task> = [];
      for (const { task, to } of moves) {
        moved.push(
          journal.keep(
            yield* fromRecords(
              tasks.moveTask(task.id, task.revision, to, scope.at, { cancelledBy: scope.caller.agentId }),
            ),
          ),
        );
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
        // The turn cancelled them itself: the failures recorded for those that ended at once are read already (#662).
        shown: yield* outcomesShown(tasks, scope, moved),
      };
    }),
});

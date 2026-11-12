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
  type Quest,
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
import { Effect, Option } from "effect";
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
  questionChoices,
  questLimitsFor,
  refuse,
  type TaskToolLimits,
} from "./call-scope.ts";
import { namedFolders, requestedFolders, withFolders } from "./default-folders.ts";
import { type DestinationDeps, missingDestinations, notThere } from "./destinations.ts";
import type { WrapUp, WrapUpPolicy } from "./wrap-up.ts";

/**
 * Why a Quest's lead may not complete it yet (#1181): it said nothing about delivering what the user
 * asked for, or said it did not. A Quest that reads done must have delivered it.
 */
const notDelivered = (task: Task, delivered: boolean | undefined) =>
  delivered === false
    ? `Task ${task.id} is not complete: you said its result does not deliver everything the user asked for. ` +
      "Finish what is missing, or ask the user with ask what to do instead. The Quest stays open meanwhile. If the user asked you to stop, call stop_quest instead."
    : `Task ${task.id} is not complete yet. Say whether its result delivers everything the user asked for, where they asked for it: ` +
      "call complete_task again with delivered: true if it does. If it does not, finish what is missing, or ask the user with ask what to do, and leave the Quest open.";

/**
 * Whether the turn making a call is your request (#1346): it answers a message of yours in the chat,
 * or carries your answer to a question its hob asked about `task`. A turn woken by a member's report,
 * a note or a finding is neither, whatever it says.
 */
const askedByYou = (tasks: TaskRepository["Service"], scope: CallScope, task: Task) =>
  Effect.gen(function* () {
    if (scope.caller.messageId !== undefined) return true;
    const carried = new Set<string>((scope.caller.carried ?? []).map((each) => each.itemId));
    if (carried.size === 0) return false;
    const ledger = yield* tasks.readLedger(task.id);
    return Option.match(ledger, {
      onNone: () => false,
      onSome: (read) =>
        read.open.some(
          (entry) =>
            entry._tag === "Item" &&
            carried.has(entry.item.id) &&
            entry.item.payload._tag === "answer" &&
            entry.item.payload.question.askerId === scope.caller.agentId &&
            entry.item.payload.question.answeredBy?._tag === "User",
        ),
    });
  });

/** What a lead is told when it tries to stop a Quest the user did not ask it to stop (#1346). */
const notAsked = (quest: Quest) =>
  `Quest ${quest.id} keeps going: only the user can ask you to stop it, in a message to you or in their answer to your ask, and this turn is neither. ` +
  "If you think it should stop, ask the user with ask, and call stop_quest in the turn their answer wakes. Otherwise go on with the work, or complete it with delivered: true if it delivers what they asked for.";

/**
 * The files a completion kept, as whoever reports it is told (#1219). A lead whose earlier completion
 * was refused for a file in its turn's temporary folder told the user that file had succeeded; what
 * it reports is what Hobbots kept, here, and nothing else.
 */
const keptText = (
  artifacts: ReadonlyArray<{ readonly kind: string; readonly label: string; readonly value: string }>,
) => {
  const files = artifacts.filter((artifact) => artifact.kind === "file");
  if (files.length === 0) return "";
  const listed = files.map((file) => `"${file.label}" at ${file.value}`).join(", ");
  return ` Hobbots kept ${listed}. Tell whoever you report to only of the files it kept: one it refused was not delivered.`;
};

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
  readonly missingAt: DestinationDeps["missingAt"];
  readonly approvedRemovals: DestinationDeps["approvedRemovals"];
  /** Why the file artifacts a Task returns could not be opened once it completes, or null (see `delivery.ts`). */
  readonly delivered: (
    folders: ReadonlyArray<string>,
    artifacts: NonNullable<TaskToolInput<"complete_task">["artifacts"]>,
  ) => Effect.Effect<string | null>;
  readonly folderChecks: FolderChecksShape;
  /** The caller's authority on a Task: its own, narrowed by every Delegation on the way down. */
  readonly authority: (scope: CallScope, task: Task) => Effect.Effect<Authority>;
  readonly separator: PathSeparator;
}

/** Whether a Task is a Quest's own top Task, whose result is the user's. */
const isQuestTop = (scope: CallScope, task: Task) =>
  task.parentId === null && scope.tree.quests.some((quest) => quest.taskId === task.id);

/**
 * Refuses a completion that would read done without the delivery: a Quest whose lead does not say
 * it delivered what the user asked for (#1181), a file no one could open afterwards (#1180), or a
 * Quest with nothing where the user asked for it (#1215).
 */
const deliveredOrRefused = (
  deps: Pick<Deps, "delivered" | "authority" | "missingAt" | "approvedRemovals" | "folderChecks" | "separator">,
  scope: CallScope,
  task: Task,
  questTop: boolean,
  input: Pick<TaskToolInput<"complete_task">, "delivered" | "artifacts">,
) =>
  Effect.gen(function* () {
    if (questTop && input.delivered !== true) {
      return yield* refuse("not-delivered", notDelivered(task, input.delivered));
    }
    const undelivered = yield* deps.delivered((yield* deps.authority(scope, task)).folders, input.artifacts ?? []);
    if (undelivered !== null) {
      return yield* refuse("artifact-unreachable", `Task ${task.id} is not complete yet. ${undelivered}`);
    }
    if (!questTop) return;
    const missing = yield* missingDestinations(deps, scope, task);
    if (missing.length > 0) return yield* refuse("not-at-destination", notThere(task, missing));
  });

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
      ...questionChoices(question),
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

/** How many open Tasks a refused `wait_for` names. */
const LISTED_TASKS = 8;

/**
 * Why `wait_for` refuses ids that are not Tasks under the caller's: it takes Task ids, and a question's
 * id names the Task the question is about, which the hob waits on instead, or not at all when it is
 * its own, since the hub wakes it with the answer (#702). The caller's own Task never waits on itself,
 * and the refusal names the open Tasks it can wait for (#1088).
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
  const own = outside.includes(task.id)
    ? [`${task.id} is the Task that waits, your own: list the Tasks under it, not the Task itself.`]
    : [];
  const open = [...under.values()].filter((each) => !isTerminalTask(each.state)).map((each) => each.id as string);
  const choices =
    open.length === 0
      ? ["No Task under it is still open, so there is nothing to wait for."]
      : [
          `The Tasks under it still open: ${open.slice(0, LISTED_TASKS).join(", ")}${open.length > LISTED_TASKS ? ", and more: read_tasks lists them" : ""}.`,
        ];
  return [
    `wait_for takes the ids of Tasks under Task ${task.id}, and these are not: ${outside.join(", ")}.`,
    ...own,
    ...questions,
    ...choices,
  ].join(" ");
};

const newMilestones = (titles: ReadonlyArray<string> | undefined) =>
  (titles ?? []).map((title) => ({ id: MilestoneId.make(newId()), title }));

/**
 * Tools a Task's owner runs its own work with: steps, a Quest, waits, the result, and cancelling
 * work under it.
 */
export const makePlanning = ({
  tasks,
  capacity,
  limits,
  wrapUp,
  delivered,
  missingAt,
  approvedRemovals,
  folderChecks,
  authority,
  separator,
}: Deps) => ({
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
      const questTop = isQuestTop(scope, task);
      yield* deliveredOrRefused(
        { delivered, authority, missingAt, approvedRemovals, folderChecks, separator },
        scope,
        task,
        questTop,
        input,
      );
      const artifacts = (input.artifacts ?? []).map((artifact) => ({ ...artifact, id: ArtifactId.make(newId()) }));
      // The Quest's own result is the user's, so its lead commits what it changed or says why not (#665).
      const attempts = scope.tree.attempts.filter((each) => each.taskId === task.id).map((each) => each.id);
      const left = yield* wrapUp(task, attempts, {
        hold: questTop,
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
      const complete = `Task ${task.id} is complete.${keptText(artifacts)}`;
      return {
        done: {
          message: left.warning === null ? complete : `${complete} ${left.warning}`,
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

  stop_quest: (scope: CallScope, input: Omit<TaskToolInput<"stop_quest">, "key">) =>
    Effect.gen(function* () {
      // The turn's own Task: a lead stops only the Quest you asked it for, never one above it.
      const task = scope.turnTask;
      const quest = scope.tree.quests.find((each) => each.taskId === task.id);
      if (task.parentId !== null || quest === undefined) {
        return yield* refuse(
          "not-a-quest",
          `Task ${task.id} is not a Quest the user asked you for, so there is no Quest of yours to stop here. To end work under it, cancel it with cancel_task.`,
        );
      }
      if (!(yield* askedByYou(tasks, scope, task))) return yield* refuse("stop-not-asked", notAsked(quest));
      const journal = journalOf();
      journal.keep(
        yield* fromRecords(
          tasks.stopQuest(quest.id, quest.revision, {
            reason: cut(input.reason, REASON_LIMIT),
            summary: cut(input.summary, REASON_LIMIT),
            at: scope.at,
          }),
        ),
      );
      // Everything under it is cancelled as Cancel Quest does; the lead's own turn ends on its own.
      const moved: Array<Task> = [];
      for (const { task: each, to } of cancelMoves(task, scope.tree)) {
        moved.push(
          journal.keep(
            yield* fromRecords(
              tasks.moveTask(each.id, each.revision, to, scope.at, { cancelledBy: scope.caller.agentId }),
            ),
          ),
        );
      }
      const cancelled = moved.filter((each) => each.id !== task.id).map((each) => each.id as string);
      return {
        done: {
          message:
            `Quest ${quest.id} stops at the user's request, without delivering it. ` +
            (cancelled.length === 0
              ? "Nothing was open under it. "
              : "Hobbots cancels the Tasks under it and confirms each as it stops. ") +
            "Tell the user in a line that you stopped it, and what was and was not done, then end your turn. Do no more work on it.",
          details: { quest_id: quest.id, cancelled },
        },
        entries: journal.entries,
        shown: yield* outcomesShown(tasks, scope, moved),
      };
    }),
});

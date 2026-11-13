import {
  AgentNotFound,
  HobUnavailable,
  QuestNotFound,
  TaskNotControllable,
  TaskNotFound,
  UserSession,
} from "@hobbots/api";
import {
  type Actor,
  type AgentId,
  type Committed,
  cancelMoves,
  HUB_ACTOR,
  type IllegalTaskTransition,
  isLiveAttempt,
  isTerminalTask,
  NoteId,
  openThreadTask,
  pausedAbove,
  pauseTargets,
  type QuestId,
  resumeNote,
  resumeRecipients,
  resumeTargets,
  type StaleTask,
  type Task,
  type TaskId,
  TaskPauses,
  type TaskRefused,
  type TaskTree,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { ChatService } from "./chat.ts";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { TaskTurns } from "./task-turns.ts";
import { TaskRepository } from "./tasks.ts";

type Refusal = TaskRefused | StaleTask | IllegalTaskTransition;

/** A refusal from the records, as the Quest tab is told it. */
const refusedFor = (taskId: TaskId) => (error: Refusal) => {
  if (error._tag === "TaskRefused") {
    return error.reason === "task-missing"
      ? new TaskNotFound({ taskId })
      : new TaskNotControllable({ taskId, reason: error.reason, message: error.message });
  }
  const message =
    error._tag === "StaleTask"
      ? `Task ${error.taskId} changed meanwhile; try again.`
      : `Task ${error.taskId} is ${error.from}, so it cannot become ${error.to}.`;
  return new TaskNotControllable({ taskId, reason: "task-state", message });
};

/** A control on one Task, made in your session. */
type OnTask<E> = (taskId: TaskId) => Effect.Effect<void, TaskNotFound | E, UserSession>;

/**
 * Your controls on a Task (ADR 018): Cancel, Pause, Resume, Retry and Reassign act on it directly, never through
 * its lead, and report what the hub did, not what it hopes (OR-006). Each needs a `UserSession`,
 * which no hob, Charm or runtime tool has (PE-006). A hob cancels work under its own Task with its
 * `cancel_task` tool instead.
 */
export class TaskControls extends Context.Service<
  TaskControls,
  {
    /**
     * Cancels the Task and everything under it with explicit commands down the tree. A Task with
     * nothing running is confirmed cancelled at once; every other is asked to stop and shows as
     * cancelling until the hub confirms it stopped, or leaves the stop unresolved when it does not
     * end in time. Cancelling the Task you asked for stops its hob's reply working on it too.
     * Cancelling again changes nothing.
     */
    readonly cancel: (taskId: TaskId) => Effect.Effect<void, TaskNotFound | TaskNotControllable, UserSession>;
    /** Cancels the Task a Quest sits on, as above, with its whole party. */
    readonly cancelQuest: (questId: QuestId) => Effect.Effect<void, QuestNotFound | TaskNotControllable, UserSession>;
    /** Queues a failed Task again for a new Attempt by its owner (EX-001). Refused while its owner is retired. */
    readonly retry: (
      taskId: TaskId,
    ) => Effect.Effect<void, TaskNotFound | TaskNotControllable | HobUnavailable, UserSession>;
    /**
     * Pauses the Task and everything under it (#1446): no turn starts there until you resume it. A
     * turn already running ends on its own, or is stopped at once with `now` (Pause now); either way
     * its Task shows pausing until it has. Pausing again changes nothing.
     */
    readonly pause: (
      taskId: TaskId,
      now: boolean,
    ) => Effect.Effect<void, TaskNotFound | TaskNotControllable, UserSession>;
    /** Pauses the Task a Quest sits on, as above, with its whole party. */
    readonly pauseQuest: (
      questId: QuestId,
      now: boolean,
    ) => Effect.Effect<void, QuestNotFound | TaskNotControllable, UserSession>;
    /**
     * Resumes the Task and everything under it you paused, each where it stood, and tells each hob
     * that goes back to work what changed while it was paused (#1446). Refused while a Task above it
     * is still paused. Resuming again changes nothing.
     */
    readonly resume: (taskId: TaskId) => Effect.Effect<void, TaskNotFound | TaskNotControllable, UserSession>;
    /** Resumes the Task a Quest sits on, as above, with its whole party. */
    readonly resumeQuest: (questId: QuestId) => Effect.Effect<void, QuestNotFound | TaskNotControllable, UserSession>;
    /**
     * Gives a party member's Task to another hob, which starts on it afresh; its Attempts,
     * checkpoints and results stay. Giving it again to the hob that has it changes nothing.
     */
    readonly reassign: (
      taskId: TaskId,
      agentId: AgentId,
    ) => Effect.Effect<void, TaskNotFound | TaskNotControllable | AgentNotFound | HobUnavailable, UserSession>;
  }
>()("@hobbots/agents/TaskControls") {
  static readonly layer = Layer.effect(
    TaskControls,
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const repo = yield* HobbotsRepository;
      const publisher = yield* EventPublisher;
      const chat = yield* ChatService;
      const turns = yield* Effect.serviceOption(TaskTurns);
      const review = Option.match(turns, { onNone: () => Effect.void, onSome: (each) => each.reviewTasks });
      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
      const announce = <A>(committed: Committed<A>) => Effect.as(publisher.publish(committed.entries), committed.value);

      /** The Task with the tree under it. */
      const subtree = (taskId: TaskId) =>
        Effect.flatMap(tasks.readTree(taskId), (found) => {
          const task = Option.isSome(found) ? found.value.tasks[0] : undefined;
          return task === undefined || Option.isNone(found)
            ? Effect.fail(new TaskNotFound({ taskId }))
            : Effect.succeed({ task, tree: found.value });
        });

      /** The Task's hob, refused when it is retired: nobody can take its work. */
      const activeHob = (agentId: AgentId) =>
        Effect.gen(function* () {
          const hob = yield* repo.findAgent(agentId);
          if (Option.isNone(hob)) return yield* new AgentNotFound({ agentId });
          if (hob.value.status === "retired") return yield* new HobUnavailable({ agentId, status: "retired" });
        });

      /**
       * Whether a reply in the thread of the Task you asked for may work on it: the Task has an
       * Attempt running, or it is the one its hob's turns there work on. A later turn works on the
       * Task without an Attempt of its own, so the Attempt alone does not tell.
       */
      const repliedOn = (task: Task, tree: TaskTree) =>
        Effect.gen(function* () {
          if (task.parentId !== null || task.threadId === null) return false;
          if (tree.attempts.some((each) => each.id === task.currentAttemptId && isLiveAttempt(each.state))) return true;
          const thread = yield* repo.findThread(task.threadId);
          if (Option.isNone(thread) || thread.value.agentId !== task.ownerId) return false;
          return openThreadTask(yield* tasks.readThreadTrees(task.threadId), task.ownerId)?.top.id === task.id;
        });

      /** Stops the thread's reply, which the stop leaves as stopped once it ended. */
      const stopReply = (task: Task) =>
        task.threadId === null
          ? Effect.void
          : chat.stop(task.threadId).pipe(Effect.catchTag("ThreadNotFound", () => Effect.void));

      const requestCancel = (taskId: TaskId) =>
        Effect.gen(function* () {
          const { task, tree } = yield* subtree(taskId);
          if (isTerminalTask(task.state) && task.state !== "cancelled") {
            return yield* new TaskNotControllable({
              taskId,
              reason: "task-ended",
              message: `Task ${taskId} is ${task.state}; there is nothing to cancel.`,
            });
          }
          // Read before the moves: once cancelled, the Task is no longer the one its hob's turns work on.
          const replying = yield* repliedOn(task, tree);
          const at = yield* nowIso;
          for (const move of cancelMoves(task, tree)) {
            yield* tasks
              .moveTask(move.task.id, move.task.revision, move.to, at, { cancelledBy: "you" })
              .pipe(Effect.mapError(refusedFor(taskId)), Effect.flatMap(announce));
          }
          if (replying) yield* stopReply(task);
        });

      const cancel = (taskId: TaskId) =>
        Effect.gen(function* () {
          yield* UserSession;
          // A Task that moved on while its moves were made is read and cancelled again from where it is now.
          yield* requestCancel(taskId).pipe(
            Effect.retry({
              while: (error) => error._tag === "TaskNotControllable" && error.reason === "task-state",
              times: 2,
            }),
          );
          yield* review;
        });

      /** The Task a Quest sits on, as a control on the Quest finds it. */
      const questTask = (questId: QuestId) =>
        Effect.flatMap(tasks.findQuest(questId), (quest) =>
          Option.isNone(quest) ? Effect.fail(new QuestNotFound({ questId })) : Effect.succeed(quest.value.taskId),
        );
      const onQuest =
        <E>(control: OnTask<E>) =>
        (questId: QuestId) =>
          Effect.flatMap(questTask(questId), (taskId) =>
            control(taskId).pipe(Effect.catchTag("TaskNotFound", () => Effect.fail(new QuestNotFound({ questId })))),
          );

      /** Moved again from where it is now when a Task under it moved meanwhile, as a cancel is. */
      const fresh = <A, R>(effect: Effect.Effect<A, TaskNotFound | TaskNotControllable, R>) =>
        effect.pipe(
          Effect.retry({
            while: (error) => error._tag === "TaskNotControllable" && error.reason === "task-state",
            times: 3,
          }),
        );

      /** Pauses every Task under `taskId`, the Task included, that is under way now, by `by`. */
      const pauseTree = (taskId: TaskId, pause: { readonly at: string; readonly by: Actor; readonly now: boolean }) =>
        Effect.gen(function* () {
          const { task, tree } = yield* subtree(taskId);
          for (const each of pauseTargets(task, tree)) {
            yield* tasks
              .pauseTask(each.id, each.revision, pause)
              .pipe(Effect.mapError(refusedFor(taskId)), Effect.flatMap(announce));
          }
        });

      const pause = (taskId: TaskId, now: boolean) =>
        Effect.gen(function* () {
          const session = yield* UserSession;
          const { task, tree } = yield* subtree(taskId);
          if (!TaskPauses.canPause(task) && !TaskPauses.isPaused(task)) {
            return yield* new TaskNotControllable({
              taskId,
              reason: "task-ended",
              message: `Task ${taskId} is ${task.state}; there is nothing to pause.`,
            });
          }
          if (pauseTargets(task, tree).length === 0) return;
          // Read before the moves: once paused, the Task is no longer the one its hob's turns work on.
          const replying = now && TaskPauses.canPause(task) && (yield* repliedOn(task, tree));
          yield* fresh(pauseTree(taskId, { at: yield* nowIso, by: session.actor, now }));
          // Pause now stops the reply working on the Task you asked for; the runner stops the rest.
          if (replying) yield* stopReply(task);
          yield* review;
        });

      /** Resumes every Task under `taskId`, the Task included, that you paused, by `by`. */
      const resumeTree = (taskId: TaskId, at: string, by: Actor) =>
        Effect.gen(function* () {
          const { task, tree } = yield* subtree(taskId);
          for (const each of resumeTargets(task, tree)) {
            yield* tasks
              .resumeTask(each.id, each.revision, { at, by })
              .pipe(Effect.mapError(refusedFor(taskId)), Effect.flatMap(announce));
          }
        });

      const resume = (taskId: TaskId) =>
        Effect.gen(function* () {
          const session = yield* UserSession;
          const { task, tree } = yield* subtree(taskId);
          const above = pausedAbove(task, tree);
          if (above !== undefined) {
            return yield* new TaskNotControllable({
              taskId,
              reason: "parent-paused",
              message: `Task ${above.id} above it is paused too; resume that one, and this one goes on with it.`,
            });
          }
          // Read before the moves, with each pause as it was, for what each hob is told.
          const resumed = resumeTargets(task, tree);
          const at = yield* nowIso;
          yield* fresh(resumeTree(taskId, at, session.actor));
          // Each hob going back to work hears what changed meanwhile, on its own Task, which wakes it.
          for (const each of resumeRecipients(resumed)) {
            yield* tasks
              .leaveNote({
                id: NoteId.make(`resume:${each.id}:${each.pause?.at ?? at}`),
                taskId: each.id,
                text: resumeNote(each, tree, at),
                createdAt: at,
                author: HUB_ACTOR,
                direct: true,
              })
              .pipe(Effect.mapError(refusedFor(taskId)), Effect.flatMap(announce));
          }
          yield* review;
        });

      return TaskControls.of({
        cancel,
        pause,
        pauseQuest: (questId, now) => onQuest((taskId) => pause(taskId, now))(questId),
        resume,
        resumeQuest: onQuest(resume),
        cancelQuest: (questId) =>
          Effect.gen(function* () {
            const quest = yield* tasks.findQuest(questId);
            if (Option.isNone(quest)) return yield* new QuestNotFound({ questId });
            yield* cancel(quest.value.taskId).pipe(
              Effect.catchTag("TaskNotFound", () => Effect.fail(new QuestNotFound({ questId }))),
            );
          }),
        retry: (taskId) =>
          Effect.gen(function* () {
            yield* UserSession;
            const { task } = yield* subtree(taskId);
            yield* activeHob(task.ownerId).pipe(Effect.catchTag("AgentNotFound", () => Effect.void));
            yield* tasks
              .retryTask(task.id, task.revision, yield* nowIso)
              .pipe(Effect.mapError(refusedFor(taskId)), Effect.flatMap(announce));
            yield* review;
          }),
        reassign: (taskId, agentId) =>
          Effect.gen(function* () {
            yield* UserSession;
            yield* activeHob(agentId);
            // A hob finishing its open Tasks before it retires takes no new ones (#408).
            const taker = yield* repo.findAgent(agentId);
            if (Option.isSome(taker) && taker.value.retiring !== null) {
              return yield* new HobUnavailable({ agentId, status: "retiring" });
            }
            const { task } = yield* subtree(taskId);
            if (task.ownerId === agentId && task.state !== "failed") return;
            yield* tasks
              .reassignTask(task.id, task.revision, agentId, yield* nowIso)
              .pipe(Effect.mapError(refusedFor(taskId)), Effect.flatMap(announce));
            yield* review;
          }),
      });
    }),
  );
}

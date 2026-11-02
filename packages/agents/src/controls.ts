import {
  AgentNotFound,
  HobUnavailable,
  QuestNotFound,
  TaskNotControllable,
  TaskNotFound,
  UserSession,
} from "@hobbots/api";
import {
  type AgentId,
  type Committed,
  cancelMoves,
  type IllegalTaskTransition,
  isLiveAttempt,
  isTerminalTask,
  type QuestId,
  type StaleTask,
  type Task,
  type TaskId,
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

/**
 * Your controls on a Task (ADR 018): Cancel, Retry and Reassign act on it directly, never through
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

      /** Stops the reply of the Task's hob that works on it, when the Task you asked for has one running. */
      const stopReply = (task: Task, tree: TaskTree) => {
        const live = tree.attempts.some((each) => each.id === task.currentAttemptId && isLiveAttempt(each.state));
        return task.parentId !== null || task.threadId === null || !live
          ? Effect.void
          : chat.stop(task.threadId).pipe(Effect.catchTag("ThreadNotFound", () => Effect.void));
      };

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
          const at = yield* nowIso;
          for (const move of cancelMoves(task, tree)) {
            yield* tasks
              .moveTask(move.task.id, move.task.revision, move.to, at)
              .pipe(Effect.mapError(refusedFor(taskId)), Effect.flatMap(announce));
          }
          yield* stopReply(task, tree);
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

      return TaskControls.of({
        cancel,
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

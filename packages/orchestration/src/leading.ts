import type { TaskRepository } from "@hobbots/agents";
import {
  descendantsOf,
  isLiveAttempt,
  isTerminalTask,
  NoteId,
  type Task,
  TaskReadiness,
  type TaskToolInput,
  type TaskToolRefused,
  type TaskTree,
} from "@hobbots/domain";
import { Effect } from "effect";
import { type CallScope, fromRecords, journalOf, ledTask, newId, ownTask, refuse } from "./call-scope.ts";

interface Deps {
  readonly tasks: TaskRepository["Service"];
}

/** How many of a Task's latest checkpoints `read_tasks` shows. */
const RECENT_CHECKPOINTS = 3;

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? "";

/** What a Task waits on now: the Tasks its owner waits for, and its dependencies, while open. */
const waitingOn = (task: Task, tree: TaskTree): ReadonlyArray<string> => {
  const open = (id: string) => {
    const each = tree.tasks.find((candidate) => candidate.id === id);
    return each !== undefined && !isTerminalTask(each.state);
  };
  const waited = tree.waits.find((wait) => wait.taskId === task.id)?.on ?? [];
  return [
    ...new Set([
      ...(task.state === "waiting" ? waited.filter(open) : []),
      ...TaskReadiness.unmet(TaskReadiness.of(task, tree.tasks)),
    ]),
  ];
};

/** One Task as `read_tasks` reports it: where it stands, what holds it and what it last said. */
const describeTask = (task: Task, tree: TaskTree, caller: string) => {
  // What its hob and the hub reported, newest first; the hub's own state changes show in `state`.
  const reported = tree.checkpoints
    .filter((each) => each.taskId === task.id && each.source !== "automatic")
    .toSorted((a, b) => b.revision - a.revision)
    .slice(0, RECENT_CHECKPOINTS);
  const attempt = tree.attempts.find((each) => each.id === task.currentAttemptId);
  return {
    task_id: task.id as string,
    parent_id: task.parentId as string | null,
    owner: task.ownerId as string,
    brief: firstLine(task.brief),
    state: task.state,
    turn_running: attempt !== undefined && isLiveAttempt(attempt.state),
    waiting_on: waitingOn(task, tree),
    open_questions: tree.questions
      .filter((question) => question.taskId === task.id && question.state === "open")
      .map((question) => ({
        question_id: question.id as string,
        question: question.text,
        waits_for: question.recipientId === caller ? "you" : ((question.recipientId ?? "the user") as string),
      })),
    recent_checkpoints: reported.map((each) => ({ kind: each.kind, summary: each.summary, at: each.createdAt })),
    ...(task.result === null ? {} : { result: task.result.summary }),
  };
};

/** The Task `read_tasks` reads under: one the caller owns, or one under a Task of its own. */
const readRoot = (scope: CallScope, id: string | undefined): Effect.Effect<Task, TaskToolRefused> =>
  id === undefined ? ownTask(scope, undefined) : ownTask(scope, id).pipe(Effect.catch(() => ledTask(scope, id)));

/**
 * Tools a lead keeps track of and talks to the work under it with (#574): it reads the state of
 * every Task under one of its own, at any depth, and sends a member a message that wakes it.
 */
export const makeLeading = ({ tasks }: Deps) => ({
  read_tasks: (scope: CallScope, input: Omit<TaskToolInput<"read_tasks">, "key">) =>
    Effect.gen(function* () {
      const root = yield* readRoot(scope, input.task_id);
      const under = descendantsOf(root, scope.tree.tasks);
      const listed = under.map((task) => describeTask(task, scope.tree, scope.caller.agentId));
      return {
        done: {
          message:
            listed.length === 0
              ? `Nothing is under Task ${root.id} yet.`
              : `${listed.length === 1 ? "1 Task is" : `${listed.length} Tasks are`} under Task ${root.id}, at every depth. This is what the records say now; nothing else is known.`,
          details: { tasks: listed },
        },
        entries: [],
      };
    }),

  message_task: (scope: CallScope, input: Omit<TaskToolInput<"message_task">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ledTask(scope, input.task_id);
      const parent = scope.tree.tasks.find((each) => each.id === task.parentId);
      if (parent?.ownerId !== scope.caller.agentId || task.ownerId === scope.caller.agentId) {
        return yield* refuse(
          "not-lead",
          `Task ${task.id} is not a member's Task directly under one of yours. Message the hob that leads it instead.`,
        );
      }
      if (isTerminalTask(task.state)) {
        return yield* refuse("task-state", `Task ${task.id} has ended as ${task.state}, so nobody would read it.`);
      }
      const journal = journalOf();
      const note = journal.keep(
        yield* fromRecords(
          tasks.leaveNote({
            id: NoteId.make(newId()),
            taskId: task.id,
            text: input.text,
            createdAt: scope.at,
            senderId: scope.caller.agentId,
          }),
        ),
      );
      return {
        done: {
          message: `Sent to hob ${task.ownerId} on Task ${task.id}. It reaches them in their next turn, and wakes them if they are not working.`,
          details: { message_id: note.id, recipient: note.recipientId },
        },
        entries: journal.entries,
      };
    }),
});

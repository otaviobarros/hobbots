import type { ChatTurn, TaskRepository } from "@hobbots/agents";
import {
  AttemptId,
  type EventEnvelope,
  isTerminalTask,
  type Task,
  TaskId,
  type TaskToolName,
  type TaskToolRefused,
  type TaskTree,
} from "@hobbots/domain";
import { Effect } from "effect";
import { BRIEF_LIMIT, cut, ownerBriefing } from "./briefs.ts";
import { fromRecords, journalOf, newId, refuse, type TaskToolCaller } from "./call-scope.ts";

/** Calls that start work, so a chat turn with no open Task starts one for its request. */
const STARTS_WORK: ReadonlySet<TaskToolName> = new Set(["plan_steps", "start_quest", "delegate_task"]);

/** Calls that need the turn's own Attempt: starting work, and returning the result it produced. */
const NEEDS_ATTEMPT: ReadonlySet<TaskToolName> = new Set([...STARTS_WORK, "complete_task"]);

/** The caller a chat turn's call resolves to, the records it wrote to get there, and the Attempt it started. */
export interface ResolvedCaller {
  readonly caller: TaskToolCaller;
  readonly entries: ReadonlyArray<EventEnvelope>;
  readonly attemptId: AttemptId | null;
}

/** The open Task the hob works on in a thread: the latest Task asked of it there that has not ended. */
const openTaskOf = (trees: ReadonlyArray<TaskTree>, turn: ChatTurn) =>
  trees
    .flatMap((tree) => {
      const top = tree.tasks[0];
      return top !== undefined && top.ownerId === turn.agentId && !isTerminalTask(top.state) ? [{ top, tree }] : [];
    })
    .at(-1);

/**
 * How a chat turn reaches the Task its hob works on in the thread. The Task is found, or started
 * from the turn's prompt, inside each call's own transaction, so a refused call leaves no Task
 * behind and two calls never start two.
 */
export const makeChatResolver = (tasks: TaskRepository["Service"], turn: ChatTurn) => ({
  /** What the turn's session is told of the open Task, read as the turn starts. */
  briefing: Effect.map(tasks.readThreadTrees(turn.threadId), (trees) => {
    const open = openTaskOf(trees, turn);
    return open === undefined ? null : ownerBriefing(open.top, open.tree);
  }),

  /** `ownAttempt` is the Attempt this turn already started, if any. */
  resolve: (
    name: TaskToolName,
    at: string,
    ownAttempt: AttemptId | null,
  ): Effect.Effect<ResolvedCaller, TaskToolRefused> =>
    Effect.gen(function* () {
      const journal = journalOf();
      let task: Task | undefined = openTaskOf(yield* tasks.readThreadTrees(turn.threadId), turn)?.top;
      if (task === undefined) {
        if (!STARTS_WORK.has(name)) {
          return yield* refuse(
            "no-task",
            "You are not working on a Task in this conversation. plan_steps, start_quest or delegate_task starts one for this request.",
          );
        }
        task = journal.keep(
          yield* fromRecords(
            tasks.createTask({
              task: {
                id: TaskId.make(newId()),
                ownerId: turn.agentId,
                parentId: null,
                threadId: turn.threadId,
                brief: cut(turn.prompt, BRIEF_LIMIT) || "A request in this conversation",
                dependsOn: [],
                createdAt: at,
              },
              delegation: null,
              milestones: [],
            }),
          ),
        );
      }
      const own = ownAttempt !== null && task.currentAttemptId === ownAttempt;
      if (own || !NEEDS_ATTEMPT.has(name) || (name !== "complete_task" && task.currentAttemptId !== null)) {
        return { caller: { agentId: turn.agentId, taskId: task.id }, entries: journal.entries, attemptId: null };
      }
      // The turn that starts the Task, or returns its result, runs it as an Attempt of its own.
      const attemptId = AttemptId.make(newId());
      journal.keep(
        yield* fromRecords(
          tasks.startAttempt(task.id, task.revision, {
            id: attemptId,
            runtime: turn.runtime,
            sessionId: null,
            configVersion: turn.configVersion,
            policyVersion: null,
            startedAt: at,
          }),
        ),
      );
      return { caller: { agentId: turn.agentId, taskId: task.id }, entries: journal.entries, attemptId };
    }),
});

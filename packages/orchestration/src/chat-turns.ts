import type { ChatTurn, TaskRepository } from "@hobbots/agents";
import {
  type AgentId,
  AttemptId,
  type CarriedItem,
  carriedFrom,
  type EventEnvelope,
  openThreadTask,
  type Task,
  TaskId,
  type TaskToolName,
  type TaskToolRefused,
  type TaskTree,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { BRIEF_LIMIT, briefingShows, cut, ownerBriefing } from "./briefs.ts";
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

/** Whether `taskId` is among `trees` and you cancelled it, or asked to. */
const cancelledIn = (trees: ReadonlyArray<TaskTree>, taskId: TaskId) =>
  trees.some((tree) => {
    const top = tree.tasks[0];
    return top?.id === taskId && (top.state === "cancelled" || top.state === "cancelling");
  });

/**
 * How a chat turn reaches the Task its hob works on in the thread. The Task is found, or started
 * from the turn's prompt, inside each call's own transaction, so a refused call leaves no Task
 * behind and two calls never start two.
 */
export const makeChatResolver = (
  tasks: TaskRepository["Service"],
  /** Refuses a new Task for a hob that already owns as many open Tasks as the hub allows. */
  hobRoom: (ownerId: AgentId, adding: number) => Effect.Effect<void, TaskToolRefused>,
  turn: ChatTurn,
) => {
  /** The Task the turn was briefed on, and the backpack items the briefing showed it. */
  let briefed: { readonly taskId: TaskId; readonly carried: ReadonlyArray<CarriedItem> } | null = null;
  /** The Task the turn works on, once it was briefed on one or a call reached one. */
  let workingOn: TaskId | null = null;
  /** The open Task as the briefing read it, for the Attempt the turn runs on it. */
  let briefedOn: Task | null = null;
  /**
   * What the turn carries on its Task: the items it holds claims on, and those its briefing showed
   * unclaimed, a held claim winning over the same item shown.
   */
  const carriedBy = (taskId: TaskId): ReadonlyArray<CarriedItem> => {
    const holding = turn.holding ?? [];
    const shown = briefed?.taskId === taskId ? briefed.carried : [];
    const held = new Set(holding.map((each) => each.itemId));
    return [...holding, ...shown.filter((each) => !held.has(each.itemId))];
  };
  return {
    /**
     * What the turn's session is told of the open Task, read as the turn starts. The briefing shows
     * each Task under it, and under its own steps, with its state and result, and the answers to the
     * questions its hob asked about it, so the turn carries those results, failures and answers in
     * its hob's backpack: they settle when the turn completes the Task. The ledger is read after the
     * tree, so only items the briefing shows at their recorded version are carried; one that
     * arrived in between stays open for a later turn.
     */
    briefing: Effect.gen(function* () {
      const open = openThreadTask(yield* tasks.readThreadTrees(turn.threadId), turn.agentId);
      if (open === undefined) return null;
      workingOn = open.top.id;
      briefedOn = open.top;
      const ledger = yield* tasks.readLedger(open.top.id);
      const shown = briefingShows(open.top, open.tree);
      briefed = {
        taskId: open.top.id,
        carried: Option.match(ledger, { onNone: () => [], onSome: (read) => carriedFrom(read, shown) }),
      };
      return ownerBriefing(open.top, open.tree);
    }),

    /**
     * Starts the turn's own Attempt on the Task it was briefed on, so the hub knows the turn is
     * working on it: a cancel then waits for the turn to stop, or leaves the stop unresolved when it
     * does not (OR-006). Null when the turn works on no Task yet, or the Task is being cancelled or
     * changed meanwhile. `was` is the Task's state before, which the turn's end gives back to it.
     */
    begin: (at: string) =>
      Effect.gen(function* () {
        const task = briefedOn;
        if (task === null || task.state === "cancelling") return null;
        const attemptId = AttemptId.make(newId());
        const started = yield* tasks
          .startAttempt(task.id, task.revision, {
            id: attemptId,
            runtime: turn.runtime,
            sessionId: null,
            configVersion: turn.configVersion,
            policyVersion: null,
            startedAt: at,
          })
          .pipe(Effect.option);
        return Option.isNone(started) ? null : { attemptId, entries: started.value.entries, was: task.state };
      }),

    /** `ownAttempt` is the Attempt this turn already started, if any. */
    resolve: (
      name: TaskToolName,
      at: string,
      ownAttempt: AttemptId | null,
    ): Effect.Effect<ResolvedCaller, TaskToolRefused> =>
      Effect.gen(function* () {
        const journal = journalOf();
        const trees = yield* tasks.readThreadTrees(turn.threadId);
        // A turn whose Task you cancelled does nothing more about it, and starts nothing in its place.
        if (workingOn !== null && cancelledIn(trees, workingOn)) {
          return yield* refuse(
            "task-cancelling",
            `Task ${workingOn} was cancelled, so this turn does no more work on it and starts none in its place.`,
          );
        }
        let task: Task | undefined = openThreadTask(trees, turn.agentId)?.top;
        if (task === undefined) {
          if (!STARTS_WORK.has(name)) {
            return yield* refuse(
              "no-task",
              "You are not working on a Task in this conversation. plan_steps, start_quest or delegate_task starts one for this request.",
            );
          }
          // The request's Task counts against its hob's open Tasks, whichever call starts it.
          yield* hobRoom(turn.agentId, 1);
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
        workingOn = task.id;
        const caller = { agentId: turn.agentId, taskId: task.id, carried: carriedBy(task.id) };
        const own = ownAttempt !== null && task.currentAttemptId === ownAttempt;
        if (own || !NEEDS_ATTEMPT.has(name) || (name !== "complete_task" && task.currentAttemptId !== null)) {
          return { caller, entries: journal.entries, attemptId: null };
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
        return { caller, entries: journal.entries, attemptId };
      }),
  };
};

import type { TaskRepository } from "@hobbots/agents";
import {
  type AttemptEnd,
  type AttemptId,
  attemptEndOf,
  type CarriedItem,
  type Committed,
  isTerminalTask,
  type Task,
  type TaskId,
  type TaskMove,
  type TaskState,
  type TurnEndInput,
  type TurnEnding,
  type TurnRunner,
  turnEnded,
} from "@hobbots/domain";
import { Effect, Option } from "effect";

export interface TurnEndDeps {
  readonly tasks: TaskRepository["Service"];
  /** A change the records may refuse, as when the Task moved on meanwhile: announced, or logged and never fatal. */
  readonly attempt: <A, E>(change: Effect.Effect<Committed<A>, E>, what: string) => Effect.Effect<Option.Option<A>>;
  /** Records why a Task cannot go on as a blocker on it. */
  readonly explain: (taskId: TaskId, reason: string, at: string) => Effect.Effect<unknown>;
}

export interface TurnOnTask {
  readonly runner: TurnRunner;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly ending: TurnEnding;
  /** The backpack items the turn carried: its completion consumes them, and they keep nothing open. */
  readonly carried: ReadonlyArray<CarriedItem>;
  /** The session the turn ran in, when its runner learnt it only as it ended. */
  readonly sessionId?: string | null;
  /** The root's state before the turn. */
  readonly was?: TaskState;
  readonly at: string;
}

/**
 * Makes the Task's move once its Attempt has ended. A blocked move records why first. Ending the
 * Attempt gives the Task's version; a blocker, or an Attempt already ended, needs it read again.
 */
const moveAfter = (
  deps: TurnEndDeps,
  taskId: TaskId,
  move: Extract<TaskMove, { _tag: "Move" }>,
  after: Option.Option<{ readonly task: Task }>,
  { at, carried }: TurnOnTask,
) =>
  Effect.gen(function* () {
    if (move.reason !== undefined) yield* deps.explain(taskId, move.reason, at);
    const now =
      Option.isSome(after) && move.reason === undefined
        ? Option.some(after.value.task)
        : Option.flatMap(yield* deps.tasks.readTree(taskId), (tree) => Option.fromNullishOr(tree.tasks[0]));
    if (Option.isSome(now) && !isTerminalTask(now.value.state))
      yield* deps.attempt(
        deps.tasks.moveTask(now.value.id, now.value.revision, move.to, at, { carried }),
        `move a Task to ${move.to}`,
      );
  });

/**
 * Ends a turn on its Task by the one turn-end decision (`turnEnded`), the same for every runner.
 * A Task the turn completes with its reply completes first and its Attempt ends after, so a restart
 * in between keeps the result. Then the Attempt ends, and the Task makes its move, which a Task
 * that ended or moved on meanwhile refuses. Returns the decision, and whether the Task completed.
 */
export const endTurn = (deps: TurnEndDeps, turn: TurnOnTask) =>
  Effect.gen(function* () {
    const { tasks, attempt } = deps;
    const ended = (end: AttemptEnd) =>
      attempt(
        tasks.updateAttempt(turn.attemptId, {
          _tag: "Ended",
          end,
          at: turn.at,
          ...(turn.sessionId == null ? {} : { sessionId: turn.sessionId }),
        }),
        "end a turn's Attempt",
      );
    const tree = Option.getOrUndefined(yield* tasks.readTree(turn.taskId));
    const task = tree?.tasks[0];
    // A Task retried or reassigned meanwhile is no longer this turn's to move: only its Attempt ends.
    if (task?.currentAttemptId !== turn.attemptId) {
      yield* ended(attemptEndOf(turn.runner, turn.ending));
      return { decided: null, completed: false };
    }
    // What the turn last reported in its Attempt; a tree lists its checkpoints in the order they were recorded.
    const report = tree?.checkpoints.findLast(
      (each) =>
        each.taskId === task.id &&
        each.attemptId === turn.attemptId &&
        each.source !== "automatic" &&
        each.kind !== "progress",
    );
    // A step's move does not depend on what is open, so only the other runners read it.
    const ledger =
      turn.runner === "step" || isTerminalTask(task.state) ? Option.none() : yield* tasks.readLedger(task.id);
    const input: TurnEndInput = {
      runner: turn.runner,
      task,
      ending: turn.ending,
      ledger: Option.match(ledger, { onNone: () => [], onSome: (each) => each.open }),
      carried: new Set(turn.carried.map((each) => each.itemId as string)),
      ...(turn.was === undefined ? {} : { was: turn.was }),
      ...(report === undefined ? {} : { lastReport: report.kind }),
    };
    const decided = turnEnded(input);
    let move = decided.task;
    if (move._tag === "Complete") {
      const explainRefusal = move.explainRefusal;
      const done = yield* attempt(
        tasks
          .completeTask(task.id, task.revision, {
            summary: move.summary,
            attemptId: turn.attemptId,
            artifacts: [],
            at: turn.at,
            carried: turn.carried,
          })
          .pipe(
            // A reply that cannot complete its Task says what was left open, when its runner asks.
            Effect.tapError((error) =>
              explainRefusal && error._tag === "TaskRefused"
                ? deps.explain(task.id, error.message, turn.at)
                : Effect.void,
            ),
          ),
        "complete a Task with its turn's reply",
      );
      if (Option.isSome(done)) {
        yield* ended(decided.cause);
        return { decided, completed: true };
      }
      move = move.otherwise;
    }
    const after = yield* ended(decided.cause);
    // A Task that changed while its turn ended, as one whose cancel arrived meanwhile, moves as it now is.
    if (Option.isSome(after) && after.value.task.state !== task.state) {
      const again = turnEnded({ ...input, task: after.value.task }).task;
      move = again._tag === "Complete" ? again.otherwise : again;
    }
    if (move._tag === "Move") yield* moveAfter(deps, task.id, move, after, turn);
    return { decided, completed: false };
  });

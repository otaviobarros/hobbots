import type { TaskRepository } from "@hobbots/agents";
import {
  type AttemptEnd,
  type AttemptId,
  attemptEndOf,
  type CarriedItem,
  type Committed,
  isTerminalTask,
  type TaskId,
  type TaskState,
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
    const found = yield* tasks.readTree(turn.taskId);
    const task = Option.isSome(found) ? found.value.tasks[0] : undefined;
    // A Task retried or reassigned meanwhile is no longer this turn's to move: only its Attempt ends.
    if (task?.currentAttemptId !== turn.attemptId) {
      yield* ended(attemptEndOf(turn.runner, turn.ending));
      return { decided: null, completed: false };
    }
    const ledger = isTerminalTask(task.state) ? Option.none() : yield* tasks.readLedger(task.id);
    const decided = turnEnded({
      runner: turn.runner,
      task,
      ending: turn.ending,
      ledger: Option.match(ledger, { onNone: () => [], onSome: (each) => each.open }),
      carried: new Set(turn.carried.map((each) => each.itemId as string)),
      ...(turn.was === undefined ? {} : { was: turn.was }),
    });
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
    if (move._tag !== "Move") return { decided, completed: false };
    if (move.reason !== undefined) yield* deps.explain(task.id, move.reason, turn.at);
    // Ending the Attempt gives the Task's version; a blocker, or an Attempt already ended, needs it read again.
    const now =
      Option.isSome(after) && move.reason === undefined
        ? Option.some(after.value.task)
        : Option.flatMap(yield* tasks.readTree(task.id), (tree) => Option.fromNullishOr(tree.tasks[0]));
    if (Option.isSome(now) && !isTerminalTask(now.value.state)) {
      const to = move.to;
      yield* attempt(tasks.moveTask(now.value.id, now.value.revision, to, turn.at), `move a Task to ${to}`);
    }
    return { decided, completed: false };
  });

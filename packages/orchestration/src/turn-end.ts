import type { TaskRepository } from "@hobbots/agents";
import {
  type AttemptId,
  attemptEndOf,
  type CarriedItem,
  type Committed,
  isTerminalTask,
  type TaskId,
  type TaskState,
  type TurnEnd,
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
    const found = yield* tasks.readTree(turn.taskId);
    // A Task retried or reassigned meanwhile is no longer this turn's to move: only its Attempt ends.
    const task = Option.isSome(found) ? found.value.tasks[0] : undefined;
    const current = task?.currentAttemptId === turn.attemptId ? task : undefined;
    const ledger =
      current === undefined || isTerminalTask(current.state) ? Option.none() : yield* tasks.readLedger(current.id);
    const decided: TurnEnd | null =
      current === undefined
        ? null
        : turnEnded({
            runner: turn.runner,
            task: current,
            ending: turn.ending,
            ledger: Option.match(ledger, { onNone: () => [], onSome: (each) => each.open }),
            carried: new Set(turn.carried.map((each) => each.itemId as string)),
            ...(turn.was === undefined ? {} : { was: turn.was }),
          });
    const completed =
      current !== undefined && decided?.task._tag === "Complete"
        ? Option.isSome(
            yield* attempt(
              tasks
                .completeTask(current.id, current.revision, {
                  summary: decided.task.summary,
                  attemptId: turn.attemptId,
                  artifacts: [],
                  at: turn.at,
                  carried: turn.carried,
                })
                .pipe(
                  // A step whose reply cannot complete it fails, saying what was left open.
                  Effect.tapError((error) =>
                    turn.runner === "step" && error._tag === "TaskRefused"
                      ? deps.explain(current.id, error.message, turn.at)
                      : Effect.void,
                  ),
                ),
              "complete a Task with its turn's reply",
            ),
          )
        : false;
    yield* attempt(
      tasks.updateAttempt(turn.attemptId, {
        _tag: "Ended",
        end: decided?.cause ?? attemptEndOf(turn.runner, turn.ending),
        at: turn.at,
        ...(turn.sessionId == null ? {} : { sessionId: turn.sessionId }),
      }),
      "end a turn's Attempt",
    );
    const move =
      decided === null || completed ? null : decided.task._tag === "Complete" ? decided.task.otherwise : decided.task;
    if (move?._tag === "Move") {
      if (move.to === "blocked" && decided?.reason) yield* deps.explain(turn.taskId, decided.reason, turn.at);
      // Read again: ending the Attempt, and a blocker, change the Task's version.
      const latest = yield* tasks.readTree(turn.taskId);
      const now = Option.isSome(latest) ? latest.value.tasks[0] : undefined;
      if (now !== undefined && !isTerminalTask(now.state))
        yield* attempt(tasks.moveTask(now.id, now.revision, move.to, turn.at), `move a Task to ${move.to}`);
    }
    return { decided, completed };
  });

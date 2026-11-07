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
  type TaskTree,
  type TurnEndInput,
  type TurnEnding,
  type TurnRunner,
  turnEnded,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { cut, RESULT_LIMIT } from "./briefs.ts";

export interface TurnEndDeps {
  readonly tasks: TaskRepository["Service"];
  /** A change the records may refuse, as when the Task moved on meanwhile: announced, or logged and never fatal. */
  readonly attempt: <A, E>(change: Effect.Effect<Committed<A>, E>, what: string) => Effect.Effect<Option.Option<A>>;
}

export interface TurnOnTask {
  readonly runner: TurnRunner;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly ending: TurnEnding;
  /** The backpack items the turn carried: its completion consumes them, and they keep nothing open. */
  readonly carried: ReadonlyArray<CarriedItem>;
  /** The session the turn ran in, and the policy version its tools ran under, when its runner learnt them only as it ended. */
  readonly sessionId?: string | null;
  readonly policyVersion?: string | null;
  /** The root's state before the turn. */
  readonly was?: TaskState;
  /** A member's turn that ran because its last one was sent back to finish properly (#1086). */
  readonly sentBack?: boolean;
  /**
   * When the member's turn began, before any turn it was sent back for: only what it reported since
   * says how it ended, since its Attempt keeps the reports of earlier turns it resumed (#1086).
   */
  readonly startedAt?: string;
  readonly at: string;
}

/**
 * Makes the Task's move once its Attempt has ended. A move with a reason records it as a blocker in
 * the same change, so its lead hears of it once (#683). Ending the Attempt gives the Task's version;
 * an Attempt already ended needs it read again.
 */
const moveAfter = (
  deps: TurnEndDeps,
  taskId: TaskId,
  move: Extract<TaskMove, { _tag: "Move" }>,
  after: Option.Option<{ readonly task: Task }>,
  { at, carried }: TurnOnTask,
) =>
  Effect.gen(function* () {
    const now = Option.isSome(after)
      ? Option.some(after.value.task)
      : Option.flatMap(yield* deps.tasks.readTree(taskId), (tree) => Option.fromNullishOr(tree.tasks[0]));
    if (Option.isSome(now) && !isTerminalTask(now.value.state))
      yield* deps.attempt(
        deps.tasks.moveTask(now.value.id, now.value.revision, move.to, at, {
          carried,
          // A reason that carries a member's reply (#1086) is cut as a result would be.
          ...(move.reason === undefined ? {} : { reason: cut(move.reason, RESULT_LIMIT) }),
        }),
        `move a Task to ${move.to}`,
      );
  });

/**
 * Completes the Task with its turn's reply, or, when the records refuse, gives the move it makes
 * instead. A runner that asks to explain the refusal gets it as that move's reason, so the lead
 * reads what was left open with the move (#683).
 */
const completeWith = (
  deps: TurnEndDeps,
  task: Task,
  move: Extract<TaskMove, { _tag: "Complete" }>,
  turn: TurnOnTask,
): Effect.Effect<true | TaskMove> =>
  Effect.gen(function* () {
    let refusal: string | undefined;
    const done = yield* deps.attempt(
      deps.tasks
        .completeTask(task.id, task.revision, {
          summary: move.summary,
          attemptId: turn.attemptId,
          artifacts: [],
          at: turn.at,
          carried: turn.carried,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error._tag === "TaskRefused") refusal = error.message;
            }),
          ),
        ),
      "complete a Task with its turn's reply",
    );
    if (Option.isSome(done)) return true;
    return move.explainRefusal && refusal !== undefined && move.otherwise._tag === "Move"
      ? { ...move.otherwise, reason: cut(refusal, RESULT_LIMIT) }
      : move.otherwise;
  });

/** What the turn-end decision reads for `turn` on `task`, as `tree` and its `open` ledger show it now. */
const inputOf = (turn: TurnOnTask, task: Task, tree: TaskTree, open: TurnEndInput["ledger"]): TurnEndInput => {
  // What the turn last reported in its Attempt; a tree lists its checkpoints in the order they were recorded.
  const report = tree.checkpoints.findLast(
    (each) =>
      each.taskId === task.id &&
      each.attemptId === turn.attemptId &&
      (turn.startedAt === undefined || each.createdAt >= turn.startedAt) &&
      each.source !== "automatic" &&
      each.kind !== "progress",
  );
  return {
    runner: turn.runner,
    task,
    ending: turn.ending,
    ledger: open,
    carried: new Set(turn.carried.map((each) => each.itemId as string)),
    ...(turn.was === undefined ? {} : { was: turn.was }),
    ...(report === undefined ? {} : { lastReport: report.kind }),
    ...(turn.sentBack === true ? { sentBack: true } : {}),
  };
};

/**
 * Ends a turn on its Task by the one turn-end decision (`turnEnded`), the same for every runner.
 * A Task the turn completes with its reply completes first and its Attempt ends after, so a restart
 * in between keeps the result. Then the Attempt ends, and the Task makes its move, which a Task
 * that ended or moved on meanwhile refuses. A member's turn sent back to finish (#1086) ends nothing:
 * its Attempt stays live for the turn that goes on in its session. Returns the decision, whether the
 * Task completed, and whether the turn was sent back.
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
          ...(turn.policyVersion == null ? {} : { policyVersion: turn.policyVersion }),
          // A step's or a member's reply is in no chat, so its end carries it to memory (ADR 028).
          ...(turn.runner !== "root" && turn.ending._tag === "Replied" && turn.ending.text.trim() !== ""
            ? { reply: turn.ending.text }
            : {}),
        }),
        "end a turn's Attempt",
      );
    const tree = Option.getOrUndefined(yield* tasks.readTree(turn.taskId));
    const task = tree?.tasks[0];
    // A Task retried or reassigned meanwhile is no longer this turn's to move: only its Attempt ends.
    if (tree === undefined || task?.currentAttemptId !== turn.attemptId) {
      yield* ended(attemptEndOf(turn.runner, turn.ending));
      return { decided: null, completed: false, sentBack: false };
    }
    // A step's move does not depend on what is open, so only the other runners read it.
    const ledger =
      turn.runner === "step" || isTerminalTask(task.state) ? Option.none() : yield* tasks.readLedger(task.id);
    const input = inputOf(turn, task, tree, Option.match(ledger, { onNone: () => [], onSome: (each) => each.open }));
    const decided = turnEnded(input);
    if (decided.task._tag === "SendBack") return { decided, completed: false, sentBack: true };
    let move: TaskMove = decided.task;
    if (move._tag === "Complete") {
      const completed = yield* completeWith(deps, task, move, turn);
      if (completed === true) {
        yield* ended(decided.cause);
        return { decided, completed: true, sentBack: false };
      }
      move = completed;
    }
    const after = yield* ended(decided.cause);
    // A Task that changed while its turn ended, as one whose cancel arrived meanwhile, moves as it now is.
    if (Option.isSome(after) && after.value.task.state !== task.state) {
      const again = turnEnded({ ...input, task: after.value.task }).task;
      // Its Attempt has ended, so a turn sent back now would have none to go on in.
      move = again._tag === "Complete" ? again.otherwise : again;
    }
    if (move._tag === "Move") yield* moveAfter(deps, task.id, move, after, turn);
    return { decided, completed: false, sentBack: false };
  });

import type { TaskRepository } from "@hobbots/agents";
import {
  type Committed,
  descendantsOf,
  isLiveAttempt,
  isTerminalTask,
  type Task,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { Clock, DateTime, Effect, Option, type Scope } from "effect";

/** Why an Attempt whose cancel could not be confirmed ended, on the Attempt itself. */
const UNRESOLVED =
  "Hobbots asked it to stop and could not confirm that it did. Whether it changed anything after that is not known.";

interface SettlerDeps {
  readonly tasks: TaskRepository["Service"];
  /** A change the records may refuse, as when the Task moved on meanwhile: logged, never fatal. */
  readonly attempt: <A, E>(change: Effect.Effect<Committed<A>, E>, what: string) => Effect.Effect<Option.Option<A>>;
  /** How long a stopped session has, in milliseconds, to end before its cancel is left unresolved. */
  readonly timeoutMs: number;
  /** Runs the settler again later, as when a cancel's time to stop runs out. */
  readonly wake: Effect.Effect<void>;
  readonly scope: Scope.Scope;
}

/**
 * Ends the cancels that were asked for (OR-006). A Task being cancelled is confirmed once its own
 * Attempt has ended and nothing under it is open, deepest first, whatever ran it: a step, a party
 * member's turn, its owner's chat turn, or nothing at all, as a member's Task that waits. An
 * Attempt that does not end within the timeout is marked unresolved, which lets its Task end as
 * cancelled while saying the stop was never confirmed.
 */
export const makeCancelSettler = ({ tasks, attempt, timeoutMs, wake, scope }: SettlerDeps) => {
  /** When each Task was first found cancelling with a live Attempt, in milliseconds. */
  const since = new Map<TaskId, number>();

  /** Whether the Task's Attempt still runs, after marking it unresolved once its time ran out. */
  const stillRunning = (task: Task, tree: TaskTree) =>
    Effect.gen(function* () {
      const live = tree.attempts.find((each) => each.id === task.currentAttemptId && isLiveAttempt(each.state));
      if (live === undefined) return false;
      const now = yield* Clock.currentTimeMillis;
      const first = since.get(task.id);
      if (first === undefined) {
        since.set(task.id, now);
        yield* Effect.forkIn(Effect.andThen(Effect.sleep(timeoutMs), wake), scope);
        return true;
      }
      if (now - first < timeoutMs) return true;
      const at = DateTime.formatIso(yield* DateTime.now);
      const marked = yield* attempt(
        tasks.updateAttempt(live.id, { state: "unresolved", outcome: UNRESOLVED, at }),
        "leave a cancel unresolved",
      );
      return Option.isNone(marked);
    });

  /** Confirms the Task's cancel if nothing runs in it or under it. Whether it did. */
  const confirm = (task: Task) =>
    Effect.gen(function* () {
      const found = yield* tasks.readTree(task.rootId);
      if (Option.isNone(found)) return false;
      const tree = found.value;
      const now = tree.tasks.find((each) => each.id === task.id);
      if (now === undefined || now.state !== "cancelling") return false;
      if (yield* stillRunning(now, tree)) return false;
      if (descendantsOf(now, tree.tasks).some((each) => !isTerminalTask(each.state))) return false;
      const at = DateTime.formatIso(yield* DateTime.now);
      const ended = yield* attempt(tasks.moveTask(now.id, now.revision, "cancelled", at), "confirm a cancel");
      if (Option.isSome(ended)) since.delete(now.id);
      return Option.isSome(ended);
    });

  /** Passes over every cancel not yet confirmed until one confirms nothing, so a Task follows what was under it. */
  return Effect.gen(function* () {
    for (let confirming = true; confirming; ) {
      confirming = false;
      for (const task of yield* tasks.listCancellingTasks) {
        if (yield* confirm(task)) confirming = true;
      }
    }
  });
};

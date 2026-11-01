import { Context, Effect, Layer, Queue } from "effect";

/**
 * Tells the step runner that Tasks changed, so it looks for steps to start or stop. A wake-up, not
 * a queue: signals that arrive while one waits collapse into one, and the records decide the work.
 */
export class TaskSignal extends Context.Service<
  TaskSignal,
  {
    readonly notify: Effect.Effect<void>;
    /** Waits for the next signal. */
    readonly next: Effect.Effect<void>;
  }
>()("@hobbots/orchestration/TaskSignal") {
  static readonly layer = Layer.effect(
    TaskSignal,
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<void>(1);
      return TaskSignal.of({ notify: Queue.offer(queue, undefined).pipe(Effect.asVoid), next: Queue.take(queue) });
    }),
  );
}

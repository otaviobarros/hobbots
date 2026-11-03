import { AdditionalRuntimes, type PromptRequest, RuntimeAdapter, type RuntimeAdapterShape } from "@hobbots/agents";
import { Context, Effect, Latch, Layer, Option, type Scope, Semaphore, Stream, SubscriptionRef } from "effect";

/**
 * The two holds a backup places while it runs (ADR 026). They live in this process's memory only, so
 * a hub that stops during a backup releases them.
 *
 * - The **cleanup hold**: the jobs that delete files do not run while it stands. New files can
 *   still be written.
 * - The **workspace hold**: no turn that can write to the default workspace starts, and the backup
 *   waits for those already running to end. A turn of a hob with folders of its own goes on.
 */
export class BackupHolds extends Context.Service<
  BackupHolds,
  {
    readonly cleanupHeld: Effect.Effect<boolean>;
    /** Holds cleanup until the scope closes. */
    readonly holdCleanup: Effect.Effect<void, never, Scope.Scope>;
    /**
     * Stops new workspace turns until the scope closes, then waits for the running ones to end,
     * reporting how many still run each time that changes.
     */
    readonly holdWorkspace: (
      waiting: (turns: number) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Runs a turn that can write to the default workspace: it waits while the hold stands. */
    readonly workspaceTurn: <A, E, R>(turn: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>;
  }
>()("@hobbots/server/BackupHolds") {
  static readonly layer = Layer.effect(
    BackupHolds,
    Effect.gen(function* () {
      const cleanup = yield* SubscriptionRef.make(0);
      // Open while no backup holds the workspace.
      const open = yield* Latch.make(true);
      const running = yield* SubscriptionRef.make(0);
      const held = { workspace: false };
      // Admitting a turn and placing the hold take turns, so no turn starts after the hold unseen.
      const gate = yield* Semaphore.make(1);

      const admit: Effect.Effect<void> = Effect.gen(function* () {
        const admitted = yield* Semaphore.withPermit(
          gate,
          Effect.gen(function* () {
            if (held.workspace) return false;
            yield* SubscriptionRef.update(running, (n) => n + 1);
            return true;
          }),
        );
        if (!admitted) {
          yield* open.await;
          yield* admit;
        }
      });
      const leave = SubscriptionRef.update(running, (n) => n - 1);

      return BackupHolds.of({
        cleanupHeld: Effect.map(SubscriptionRef.get(cleanup), (n) => n > 0),
        holdCleanup: Effect.acquireRelease(
          SubscriptionRef.update(cleanup, (n) => n + 1),
          () => SubscriptionRef.update(cleanup, (n) => n - 1),
        ),
        holdWorkspace: (waiting) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Semaphore.withPermit(
                gate,
                Effect.gen(function* () {
                  held.workspace = true;
                  yield* open.close;
                }),
              ),
              () =>
                Semaphore.withPermit(
                  gate,
                  Effect.gen(function* () {
                    held.workspace = false;
                    yield* open.open;
                  }),
                ),
            );
            yield* SubscriptionRef.changes(running).pipe(
              Stream.tap(waiting),
              Stream.takeUntil((n) => n <= 0),
              Stream.runDrain,
            );
          }),
        workspaceTurn: (turn) => Stream.unwrap(Effect.acquireRelease(admit, () => leave).pipe(Effect.as(turn))),
      });
    }),
  );
}

/**
 * Whether a turn can write to the default workspace: a turn of a hob without folders of its own runs
 * there. A turn with folders starts in its first folder, inside Hobbots' sandbox (ADR 014).
 */
const writesDefaultWorkspace = (request: PromptRequest) => (request.tools?.folders.length ?? 0) === 0;

/** The runtime adapter with its default-workspace turns under the workspace hold. */
const heldAdapter = (holds: BackupHolds["Service"], adapter: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...adapter,
  sendPrompt: (request) =>
    writesDefaultWorkspace(request) ? holds.workspaceTurn(adapter.sendPrompt(request)) : adapter.sendPrompt(request),
});

/**
 * Every runtime adapter of the hub, Claude Code's and any additional ones, with its default-workspace
 * turns under the workspace hold. Provided over `runtimes`, it replaces their adapters.
 */
export const HeldRuntimes = Layer.effectContext(
  Effect.gen(function* () {
    const holds = yield* BackupHolds;
    const claude = Context.make(RuntimeAdapter, heldAdapter(holds, yield* RuntimeAdapter));
    const others = yield* Effect.serviceOption(AdditionalRuntimes);
    if (Option.isNone(others)) return claude;
    const held = new Map([...others.value].map(([kind, adapter]) => [kind, heldAdapter(holds, adapter)] as const));
    return Context.add(claude, AdditionalRuntimes, held);
  }),
);

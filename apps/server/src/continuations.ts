import { type CarriedWork, ChatService, Continuations } from "@hobbots/agents";
import type { AgentId, BackpackItem, ThreadId } from "@hobbots/domain";
import {
  arrivalsText,
  Backpack,
  type BackpackScope,
  BackpackTurnFailed,
  carryingThread,
  type Delivery,
  Dispatcher,
  DispatcherHost,
} from "@hobbots/inbox";
import { DateTime, Effect, Layer, Stream } from "effect";
import { EventBus } from "./event-bus.ts";

/**
 * The dispatcher's continuation branch (ADR 019): which threads have backpack work waiting for
 * their hob, and putting that work into one turn there under the dispatcher's claims. Routine
 * progress rides along that turn as one digest, and never starts a turn on its own (IN-005).
 */
export const ContinuationsLive = Layer.effect(
  Continuations,
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const dispatcher = yield* Dispatcher;
    const host = yield* DispatcherHost;

    /**
     * Each open item that waits for a turn now, with the thread whose next turn carries it. Routine
     * progress is among them only with `routine`: it rides along a turn but never starts one.
     */
    const routed = (scope: BackpackScope, routine: boolean) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const open = yield* backpack.listOpen(scope);
        const waiting = open.filter(
          (item) =>
            item.state === "pending" &&
            (routine || item.actionable) &&
            (item.notBefore === null || item.notBefore <= now),
        );
        return yield* Effect.forEach(waiting, (item) =>
          Effect.map(item.taskId === null ? Effect.succeed([]) : host.treeOf(item.taskId), (tree) => ({
            item,
            threadId: carryingThread(item, tree),
          })),
        );
      });

    const waiting: Continuations["Service"]["waiting"] = (agentId) =>
      Effect.map(routed(agentId === undefined ? { _tag: "Workspace" } : { _tag: "Hob", agentId }, false), (items) => [
        ...new Set(items.flatMap(({ threadId }) => (threadId === null ? [] : [threadId]))),
      ]);

    const progressWaits: Continuations["Service"]["progressWaits"] = (threadId, agentId) =>
      Effect.map(routed({ _tag: "Hob", agentId }, true), (items) =>
        items.some(({ item, threadId: carried }) => !item.actionable && carried === threadId),
      );

    const workOf = (deliveries: ReadonlyArray<Delivery>): CarriedWork => {
      const items: ReadonlyArray<BackpackItem> = deliveries.map((delivery) => delivery.item);
      return {
        text: (as) => arrivalsText(items, as),
        routineOnly: !items.some((item) => item.actionable),
        holding: deliveries.map(({ item, held }) => ({ itemId: item.id, owner: held.owner, token: held.token })),
        // A claim lost meanwhile is found when the turn ends, which then drops its outcome.
        accepted: (sessionId) =>
          Effect.forEach(deliveries, (delivery) => delivery.accepted(sessionId), { discard: true }).pipe(
            Effect.catchTag("StaleBackpackClaim", () =>
              Effect.logWarning("A turn's backpack claim expired before its runtime accepted it"),
            ),
          ),
      };
    };

    const deliver: Continuations["Service"]["deliver"] = (threadId: ThreadId, agentId: AgentId, turn) =>
      Effect.gen(function* () {
        const items = (yield* routed({ _tag: "Hob", agentId }, true)).filter((each) => each.threadId === threadId);
        if (items.length === 0) return false;
        let ran = false;
        yield* dispatcher.dispatchAll(
          items.map(({ item }) => item.id),
          // Planned again after an early end, the turn sees only the items still waiting.
          (found) =>
            Effect.map(turn.plan(!found.some((item) => item.actionable)), (replyId) =>
              replyId === null
                ? null
                : {
                    target: `thread:${threadId}`,
                    turnId: replyId,
                    run: (deliveries: ReadonlyArray<Delivery>) =>
                      Effect.gen(function* () {
                        ran = true;
                        const ended = yield* turn.run(replyId, workOf(deliveries));
                        if (ended._tag === "EndedEarly") return yield* new BackpackTurnFailed({ reason: ended.reason });
                      }),
                  },
            ),
        );
        return ran;
      });

    return Continuations.of({ waiting, progressWaits, deliver });
  }),
);

/**
 * Wakes a thread when work arrives for its hob (ADR 019): after a commit that records an
 * actionable item, or sends one back to pending, as an expired claim does. The announcement only
 * wakes the chat; the stored items decide what runs.
 */
export const WakeOnArrival = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const chat = yield* ChatService;
    const continuations = yield* Continuations;
    const subscription = yield* bus.subscribe;
    const wake = (item: BackpackItem) =>
      item.state === "pending" && item.actionable && item.threadId !== null
        ? chat
            .wake(item.threadId)
            .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not wake a thread for its hob's work", cause)))
        : Effect.void;
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event) =>
        event._tag === "Journaled" &&
        (event.entry.payload._tag === "BackpackItemRecorded" || event.entry.payload._tag === "BackpackItemChanged")
          ? wake(event.entry.payload.item)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    // Subscribed now: work recorded since the chat first looked at start is woken here.
    yield* Effect.forEach(yield* continuations.waiting(), (threadId) => chat.wake(threadId), { discard: true });
  }),
);

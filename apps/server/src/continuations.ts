import { type CarriedWork, type CarryingTurn, ChatService, Continuations, MemberContinuations } from "@hobbots/agents";
import type { AgentId, BackpackItem, Task, TaskId, ThreadId } from "@hobbots/domain";
import {
  arrivalsText,
  Backpack,
  type BackpackScope,
  BackpackTurnFailed,
  carryingThread,
  continuationTask,
  type Delivery,
  Dispatcher,
  DispatcherHost,
} from "@hobbots/inbox";
import { TaskSignal } from "@hobbots/orchestration";
import { DateTime, Effect, Layer, Option, Stream } from "effect";
import { EventBus } from "./event-bus.ts";

/** What the continuation branches share: the backpack's waiting work, and putting it into one turn. */
const makeCarrier = Effect.gen(function* () {
  const backpack = yield* Backpack;
  const dispatcher = yield* Dispatcher;
  const host = yield* DispatcherHost;

  /**
   * Each open item that waits for a turn now, with the Task tree it is routed by. Routine progress
   * is among them only with `routine`: it rides along a turn but never starts one (IN-005).
   */
  const routed = (scope: BackpackScope, routine = false) =>
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
        Effect.map(
          item.taskId === null ? Effect.succeed<ReadonlyArray<Task>>([]) : host.treeOf(item.taskId),
          (tree) => ({ item, tree }),
        ),
      );
    });

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

  /** Puts the items into one turn of the session `target` names, run with `turn`. Returns whether it ran. */
  const carry = <Id extends string>(
    items: ReadonlyArray<BackpackItem>,
    target: string,
    turn: CarryingTurn<Id>,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (items.length === 0) return false;
      let ran = false;
      yield* dispatcher.dispatchAll(
        items.map((item) => item.id),
        // Planned again after an early end, the turn sees only the items still waiting.
        (found) =>
          Effect.map(turn.plan(!found.some((item) => item.actionable)), (turnId) =>
            turnId === null
              ? null
              : {
                  target,
                  turnId,
                  run: (deliveries: ReadonlyArray<Delivery>) =>
                    Effect.gen(function* () {
                      ran = true;
                      const ended = yield* turn.run(turnId, workOf(deliveries));
                      if (ended._tag === "EndedEarly") {
                        return yield* new BackpackTurnFailed({ end: ended.end, diagnostic: ended.diagnostic });
                      }
                    }),
                },
          ),
      );
      return ran;
    });

  return { routed, carry };
});

/**
 * The dispatcher's continuation branch (ADR 019): which threads have backpack work waiting for
 * their hob, and putting that work into one turn there under the dispatcher's claims. Routine
 * progress rides along that turn as one digest, and never starts a turn on its own (IN-005).
 */
export const ContinuationsLive = Layer.effect(
  Continuations,
  Effect.gen(function* () {
    const { routed, carry } = yield* makeCarrier;
    const threaded = (scope: BackpackScope, routine = false) =>
      Effect.map(routed(scope, routine), (all) =>
        all.map(({ item, tree }) => ({ item, threadId: carryingThread(item, tree) })),
      );

    const waiting: Continuations["Service"]["waiting"] = (agentId) =>
      Effect.map(threaded(agentId === undefined ? { _tag: "Workspace" } : { _tag: "Hob", agentId }), (items) => [
        ...new Set(items.flatMap(({ threadId }) => (threadId === null ? [] : [threadId]))),
      ]);

    const progressWaits: Continuations["Service"]["progressWaits"] = (threadId, agentId) =>
      Effect.map(threaded({ _tag: "Hob", agentId }, true), (items) =>
        items.some(({ item, threadId: carried }) => !item.actionable && carried === threadId),
      );

    const deliver: Continuations["Service"]["deliver"] = (threadId: ThreadId, agentId: AgentId, turn) =>
      Effect.gen(function* () {
        const items = (yield* threaded({ _tag: "Hob", agentId }, true)).filter((each) => each.threadId === threadId);
        return yield* carry(
          items.map(({ item }) => item),
          `thread:${threadId}`,
          turn,
        );
      });

    return Continuations.of({ waiting, progressWaits, deliver });
  }),
);

/**
 * The same branch for a party member's Task (ADR 019): the work its owner holds under it waits for
 * one turn of the session that works it, never for a thread.
 */
export const MemberContinuationsLive = Layer.effect(
  MemberContinuations,
  Effect.gen(function* () {
    const { routed, carry } = yield* makeCarrier;
    const tasked = (scope: BackpackScope) =>
      Effect.map(routed(scope), (all) =>
        all.flatMap(({ item, tree }) => {
          const task = continuationTask(item, tree);
          return task === undefined ? [] : [{ item, taskId: task.id }];
        }),
      );

    const waiting: MemberContinuations["Service"]["waiting"] = Effect.map(tasked({ _tag: "Workspace" }), (items) => {
      const seen = new Map<TaskId, AgentId>();
      for (const { item, taskId } of items) seen.set(taskId, item.recipientId);
      return [...seen].map(([taskId, agentId]) => ({ taskId, agentId }));
    });

    const deliver: MemberContinuations["Service"]["deliver"] = (taskId, agentId, turn) =>
      Effect.gen(function* () {
        const items = (yield* tasked({ _tag: "Hob", agentId })).filter((each) => each.taskId === taskId);
        return yield* carry(
          items.map(({ item }) => item),
          `task:${taskId}`,
          turn,
        );
      });

    return MemberContinuations.of({ waiting, deliver });
  }),
);

/**
 * Wakes a thread when work arrives for its hob (ADR 019): after a commit that records an
 * actionable item, or sends one back to pending, as an expired claim does. The announcement only
 * wakes the chat, and the runner of members' Tasks when the hub has one; the stored items decide
 * what runs.
 */
export const WakeOnArrival = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const chat = yield* ChatService;
    const continuations = yield* Continuations;
    const signal = yield* Effect.serviceOption(TaskSignal);
    const subscription = yield* bus.subscribe;
    const wake = (item: BackpackItem) =>
      item.state !== "pending" || !item.actionable
        ? Effect.void
        : Effect.all([
            item.threadId === null ? Effect.void : chat.wake(item.threadId),
            Option.isSome(signal) ? signal.value.notify : Effect.void,
          ]).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not wake a thread for its hob's work", cause)));
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

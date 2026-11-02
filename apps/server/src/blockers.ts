import { ChatService, EventPublisher, HobbotsRepository } from "@hobbots/agents";
import { BackpackItemNotFound, BlockerClosed, HobbotsApi, HobUnavailable } from "@hobbots/api";
import type { AgentId, BackpackItem, BackpackItemId } from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { EventJournal } from "@hobbots/persistence";
import { Effect, Layer, Option, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { EventBus } from "./event-bus.ts";
import { formatCursor } from "./event-stream.ts";
import { UserSessionOnlyLive } from "./user-session.ts";

const RETIRED = "Its hob retired, so nobody can take it.";

/**
 * Your choice for a blocker (IN-007). Making the same choice again, as a client retrying its
 * request, finds it made. Retry is refused while the item's hob is retired, and wakes the item's
 * thread even where you had stopped its work, since choosing Retry asks for it again.
 */
export const decideBlocker = (itemId: BackpackItemId, action: "retry" | "dismiss") =>
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const item = yield* backpack
      .find(itemId)
      .pipe(Effect.catchTag("BackpackItemMissing", () => new BackpackItemNotFound({ itemId })));
    if (item.state !== "failed") {
      if (item.blockers.at(-1)?.decision === action) return item;
      return yield* new BlockerClosed({ itemId, state: item.state });
    }
    if (action === "retry") {
      const hob = yield* HobbotsRepository.use((repo) => repo.findAgent(item.recipientId));
      if (Option.isSome(hob) && hob.value.status === "retired") {
        return yield* new HobUnavailable({ agentId: item.recipientId, status: "retired" });
      }
    }
    const committed = yield* backpack.decide(itemId, action).pipe(
      Effect.catchTags({
        BackpackItemMissing: () => new BackpackItemNotFound({ itemId }),
        // Another request made a choice first: the same one finds it made, as above.
        BackpackItemNotBlocked: () =>
          Effect.flatMap(backpack.find(itemId).pipe(Effect.orDie), (now) =>
            now.blockers.at(-1)?.decision === action
              ? Effect.succeed({ value: now, entries: [] })
              : Effect.fail(new BlockerClosed({ itemId, state: now.state })),
          ),
      }),
    );
    yield* EventPublisher.use((publisher) => publisher.publish(committed.entries));
    const threadId = committed.value.threadId;
    if (action === "retry" && threadId !== null) yield* ChatService.use((chat) => chat.resume(threadId));
    return committed.value;
  });

/** Blockers (IN-007): the failed items that wait for your choice, and your choice. */
export const BlockersHandlers = HttpApiBuilder.group(HobbotsApi, "blockers", (handlers) =>
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const journal = yield* EventJournal;
    const context = yield* Effect.context<Backpack | HobbotsRepository | ChatService | EventPublisher>();
    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const head = yield* journal.head;
          const items = yield* backpack.listBlocked({ _tag: "Workspace" });
          return { cursor: formatCursor(head.epoch, head.sequence), items };
        }),
      decide: ({ params, payload }) => decideBlocker(params.itemId, payload.action).pipe(Effect.provide(context)),
    });
  }),
).pipe(Layer.provide(UserSessionOnlyLive));

/**
 * A retired hob's work fails as blockers (ADR 019, IN-007): nobody can take it, so it waits for
 * your choice instead of staying pending for good. Its open items fail when it retires, and an item
 * that reaches it later, or comes back to pending once the turn that held it ends, fails then.
 * At start, what an earlier process left pending for a retired hob fails the same way.
 */
export const BlockOnRetirement = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const backpack = yield* Backpack;
    const repo = yield* HobbotsRepository;
    const publisher = yield* EventPublisher;

    const retired = (agentId: AgentId) =>
      repo.findAgent(agentId).pipe(Effect.map((hob) => Option.isSome(hob) && hob.value.status === "retired"));

    const abandon = (item: BackpackItem) =>
      backpack.abandon(item.id, RETIRED).pipe(
        Effect.flatMap((committed) => publisher.publish(committed.entries)),
        Effect.catchCause((cause) => Effect.logWarning("Could not fail a retired hob's backpack item", cause)),
      );

    // Routine progress never needs your choice, so only actionable work becomes a blocker.
    const abandonAll = (agentId: AgentId) =>
      backpack.listOpen({ _tag: "Hob", agentId }).pipe(
        Effect.flatMap((items) =>
          Effect.forEach(
            items.filter((item) => item.actionable),
            abandon,
            { discard: true },
          ),
        ),
      );

    const subscription = yield* bus.subscribe;
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event) => {
        if (event._tag !== "Journaled") return Effect.void;
        const payload = event.entry.payload;
        if (payload._tag === "AgentUpserted" && payload.agent.status === "retired") return abandonAll(payload.agent.id);
        if (
          (payload._tag === "BackpackItemRecorded" || payload._tag === "BackpackItemChanged") &&
          payload.item.state === "pending" &&
          payload.item.actionable
        ) {
          return Effect.flatMap(retired(payload.item.recipientId), (gone) =>
            gone ? abandon(payload.item) : Effect.void,
          );
        }
        return Effect.void;
      }),
      Effect.forkScoped,
    );
    // Subscribed now: what was left pending for a retired hob before this start fails here.
    const open = yield* backpack.listOpen({ _tag: "Workspace" });
    const recipients = [...new Set(open.map((item) => item.recipientId))];
    const gone = yield* Effect.filter(recipients, retired);
    yield* Effect.forEach(gone, abandonAll, { discard: true });
  }),
);

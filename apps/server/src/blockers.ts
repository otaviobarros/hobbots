import { ChatService, EventPublisher, HobbotsRepository } from "@hobbots/agents";
import { BackpackItemNotFound, BlockerClosed, HobbotsApi, HobUnavailable } from "@hobbots/api";
import {
  Backpack,
  BlockersHost,
  blockIfRecipientRetired,
  blockRetiredHob,
  blockRetiredWork,
  decideBlocker,
} from "@hobbots/inbox";
import { EventJournal } from "@hobbots/persistence";
import { Effect, Layer, Option, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { EventBus } from "./event-bus.ts";
import { formatCursor } from "./event-stream.ts";
import { UserSessionOnlyLive } from "./user-session.ts";

/** What blockers read and announce through: the hob's status, the hub's event bus and the chat. */
export const BlockersHostLive = Layer.effect(
  BlockersHost,
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const publisher = yield* EventPublisher;
    const chat = yield* ChatService;
    return BlockersHost.of({
      isRetired: (agentId) =>
        repo.findAgent(agentId).pipe(Effect.map((hob) => Option.isSome(hob) && hob.value.status === "retired")),
      announce: publisher.publish,
      resume: chat.resume,
    });
  }),
);

/** Blockers (IN-007) over HTTP: the failed items that wait for your choice, and your choice. */
export const BlockersHandlers = HttpApiBuilder.group(HobbotsApi, "blockers", (handlers) =>
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const journal = yield* EventJournal;
    const context = yield* Effect.context<Backpack | BlockersHost>();
    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const head = yield* journal.head;
          const items = yield* backpack.listBlocked({ _tag: "Workspace" });
          return { cursor: formatCursor(head.epoch, head.sequence), items };
        }),
      decide: ({ params, payload }) =>
        decideBlocker(params.itemId, payload.blocker, payload.action).pipe(
          Effect.catchTags({
            BackpackItemMissing: ({ itemId }) => new BackpackItemNotFound({ itemId }),
            BackpackItemNotBlocked: ({ itemId, blocker, state }) => new BlockerClosed({ itemId, blocker, state }),
            BlockerRecipientRetired: ({ agentId }) => new HobUnavailable({ agentId, status: "retired" }),
          }),
          Effect.provide(context),
        ),
    });
  }),
).pipe(Layer.provide(BlockersHostLive), Layer.provide(UserSessionOnlyLive));

/**
 * Fails a retired hob's work as blockers as it happens: when the hob retires, when an item reaches
 * it or comes back to pending, and at start for what an earlier process left (ADR 019, IN-007).
 */
export const BlockOnRetirement = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const context = yield* Effect.context<Backpack | BlockersHost>();
    const subscription = yield* bus.subscribe;
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event) => {
        if (event._tag !== "Journaled") return Effect.void;
        const payload = event.entry.payload;
        if (payload._tag === "AgentUpserted" && payload.agent.status === "retired") {
          return blockRetiredHob(payload.agent.id);
        }
        if (payload._tag === "BackpackItemRecorded" || payload._tag === "BackpackItemChanged") {
          return blockIfRecipientRetired(payload.item);
        }
        return Effect.void;
      }),
      Effect.provide(context),
      Effect.forkScoped,
    );
    // Subscribed now: what was left open for a retired hob before this start fails here.
    yield* blockRetiredWork;
  }),
).pipe(Layer.provide(BlockersHostLive));

import {
  type AgentId,
  type BackpackItem,
  type BackpackItemId,
  BackpackItemNotBlocked,
  BlockerRecipientRetired,
  type EventEnvelope,
  openBlocker,
  type ThreadId,
} from "@hobbots/domain";
import { Context, Effect } from "effect";
import { Backpack } from "./backpack.ts";

/** What blockers need from the hub around them. */
export class BlockersHost extends Context.Service<
  BlockersHost,
  {
    /** Whether the hob is retired, so nobody can take its work. */
    readonly isRetired: (agentId: AgentId) => Effect.Effect<boolean>;
    /** Announces what a backpack write committed, after it committed. */
    readonly announce: (entries: ReadonlyArray<EventEnvelope>) => Effect.Effect<void>;
    /** Asks the thread for its work again, even where you had stopped it. */
    readonly resume: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("@hobbots/inbox/BlockersHost") {}

/** The named blocker already took this choice, so making it again finds it made. */
const madeAlready = (item: BackpackItem, blocker: number, action: "retry" | "dismiss") =>
  item.blockers.find((each) => each.number === blocker)?.decision === action;

/**
 * Your choice for the item's blocker numbered `blocker` (IN-007). The choice binds to that blocker:
 * once the item failed again, a choice made for the earlier one is refused rather than taken by the
 * newer. Making the same choice again for the same blocker, as a client retrying its request, finds
 * it made and changes nothing. Retry is refused while the item's hob is retired, and asks the
 * item's thread for its work again even where you had stopped it.
 */
export const decideBlocker = (itemId: BackpackItemId, blocker: number, action: "retry" | "dismiss") =>
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const host = yield* BlockersHost;
    const item = yield* backpack.find(itemId);
    if (madeAlready(item, blocker, action)) return item;
    if (openBlocker(item)?.number !== blocker) {
      return yield* new BackpackItemNotBlocked({ itemId, blocker, state: item.state });
    }
    if (action === "retry" && (yield* host.isRetired(item.recipientId))) {
      return yield* new BlockerRecipientRetired({ itemId, agentId: item.recipientId });
    }
    const committed = yield* backpack.decide(itemId, blocker, action).pipe(
      // Another request chose first: the same choice finds it made, as above.
      Effect.catchTag("BackpackItemNotBlocked", (refused) =>
        Effect.flatMap(backpack.find(itemId).pipe(Effect.orDie), (now) =>
          madeAlready(now, blocker, action) ? Effect.succeed({ value: now, entries: [] }) : Effect.fail(refused),
        ),
      ),
    );
    yield* host.announce(committed.entries);
    const threadId = committed.value.threadId;
    if (action === "retry" && committed.entries.length > 0 && threadId !== null) yield* host.resume(threadId);
    return committed.value;
  });

/**
 * A retired hob's work fails as blockers (ADR 019, IN-007): nobody can take it, so it waits for
 * your choice instead of staying pending for good. Routine progress never needs your choice, so
 * only actionable work becomes a blocker; a claimed item fails once its turn ends and it is back
 * to pending.
 */
const abandon = (item: BackpackItem) =>
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const host = yield* BlockersHost;
    const committed = yield* backpack.abandon(item.id);
    yield* host.announce(committed.entries);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not fail a retired hob's backpack item", cause)));

/** The hob retired: its open actionable work fails as blockers. */
export const blockRetiredHob = (agentId: AgentId) =>
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const items = yield* backpack.listOpen({ _tag: "Hob", agentId });
    yield* Effect.forEach(
      items.filter((item) => item.actionable),
      abandon,
      { discard: true },
    );
  });

/** An item that is pending again, or new, fails as a blocker when its hob is retired. */
export const blockIfRecipientRetired = (item: BackpackItem) =>
  Effect.gen(function* () {
    if (item.state !== "pending" || !item.actionable) return;
    const host = yield* BlockersHost;
    if (yield* host.isRetired(item.recipientId)) yield* abandon(item);
  });

/** At start: what an earlier process left open for a retired hob fails as blockers. */
export const blockRetiredWork = Effect.gen(function* () {
  const backpack = yield* Backpack;
  const host = yield* BlockersHost;
  const open = yield* backpack.listOpen({ _tag: "Workspace" });
  const recipients = [...new Set(open.map((item) => item.recipientId))];
  const gone = yield* Effect.filter(recipients, host.isRetired);
  yield* Effect.forEach(gone, blockRetiredHob, { discard: true });
});

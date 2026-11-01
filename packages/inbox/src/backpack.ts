import type {
  AgentId,
  BackpackDisposition,
  BackpackItem,
  BackpackItemId,
  BackpackItemMissing,
  BackpackItemUnclaimable,
  Committed,
  IllegalBackpackTransition,
  QuestId,
  StaleBackpackClaim,
} from "@hobbots/domain";
import { Context, type Duration, type Effect } from "effect";

/** The claim a write is made under: who holds it and the fencing token it was given. */
export interface HeldClaim {
  readonly owner: string;
  readonly token: number;
}

type Guarded = Effect.Effect<
  Committed<BackpackItem>,
  BackpackItemMissing | StaleBackpackClaim | IllegalBackpackTransition
>;

/** Which open items to read: one hob's, one Quest's, or the whole workspace's. */
export type BackpackScope =
  | { readonly _tag: "Hob"; readonly agentId: AgentId }
  | { readonly _tag: "Quest"; readonly questId: QuestId }
  | { readonly _tag: "Workspace" };

/**
 * The backpack store (ADR 019). Items are recorded by the repositories, in the transaction of the
 * change that causes them; this port moves them on. Every step after the claim runs under it: a
 * write whose claim is not the live one, by owner, fencing token and lease, changes nothing.
 */
export class Backpack extends Context.Service<
  Backpack,
  {
    /** Claims a pending item for `owner`, raising its fencing token, with a lease of `lease`. */
    readonly claim: (
      itemId: BackpackItemId,
      owner: string,
      lease: Duration.Input,
    ) => Effect.Effect<Committed<BackpackItem>, BackpackItemMissing | BackpackItemUnclaimable>;
    /** Extends the lease of a claim that still holds. */
    readonly renew: (itemId: BackpackItemId, held: HeldClaim, lease: Duration.Input) => Guarded;
    /** Records that the item was put into a turn: `target` is its thread or session, `turnId` its message or Attempt. */
    readonly deliver: (
      itemId: BackpackItemId,
      held: HeldClaim,
      delivery: { readonly target: string; readonly turnId: string },
    ) => Guarded;
    /** Records the adapter's evidence that the runtime accepted the turn of the latest delivery. */
    readonly acknowledge: (itemId: BackpackItemId, held: HeldClaim, sessionId: string) => Guarded;
    /** The acknowledged turn is running with the item. */
    readonly process: (itemId: BackpackItemId, held: HeldClaim) => Guarded;
    /** The turn ended early: the item goes back to pending, unclaimed, for a new attempt. */
    readonly requeue: (itemId: BackpackItemId, held: HeldClaim) => Guarded;
    readonly resolve: (itemId: BackpackItemId, held: HeldClaim, disposition: BackpackDisposition) => Guarded;
    readonly fail: (itemId: BackpackItemId, held: HeldClaim, error: string) => Guarded;
    /**
     * Runs `effect` in one transaction that first checks the claim still holds, by owner, token and
     * lease, and that the runtime accepted the item's turn. When the check fails, nothing of the
     * effect is written. With `consumes`, the item resolves as consumed by `consumes` in the same
     * transaction, so the effect and the item's outcome commit together or not at all.
     */
    readonly fenced: <A, E, R>(
      itemId: BackpackItemId,
      held: HeldClaim,
      effect: Effect.Effect<A, E, R>,
      options?: { readonly consumes?: string },
    ) => Effect.Effect<
      { readonly value: A; readonly settled: Committed<BackpackItem> | null },
      E | BackpackItemMissing | StaleBackpackClaim | IllegalBackpackTransition,
      R
    >;
    /**
     * Ends claims without their owners: every claim whose lease ran out, or with `all`, every claim,
     * as at boot when the turns that held them are gone. Each item's token rises and it goes back
     * to pending, so its old worker is refused at once.
     */
    readonly expireClaims: (options?: {
      readonly all?: boolean;
    }) => Effect.Effect<Committed<ReadonlyArray<BackpackItem>>>;
    readonly find: (itemId: BackpackItemId) => Effect.Effect<BackpackItem, BackpackItemMissing>;
    /** Items not yet resolved or failed, highest priority first, then oldest first. */
    readonly listOpen: (scope: BackpackScope) => Effect.Effect<ReadonlyArray<BackpackItem>>;
  }
>()("@hobbots/inbox/Backpack") {}

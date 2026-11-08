import type { AgentId, HobChange } from "@hobbots/domain";
import { Context, type Effect } from "effect";

/**
 * Every change to a hob, read back for its History and the Changes log (ADR 034): its configuration
 * versions, each with the one before it, and its pauses, wakes, retirements and returns, each with
 * who made it and, for a hob's change, the request behind it. Newest first.
 */
export class HobChanges extends Context.Service<
  HobChanges,
  {
    /** Every change to the hob. */
    readonly forHob: (hobId: AgentId) => Effect.Effect<ReadonlyArray<HobChange>>;
    /** The newest `limit` changes across every hob. */
    readonly latest: (limit: number) => Effect.Effect<ReadonlyArray<HobChange>>;
  }
>()("@hobbots/agents/HobChanges") {}

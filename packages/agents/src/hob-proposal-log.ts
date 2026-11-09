import type { AgentId, Committed, HobProposal, HobProposalId } from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";

/**
 * Where hob proposals are kept (ADR 034, Asking is a proposal), by the hub's database. Every write
 * journals its event in the same transaction.
 */
export class HobProposalLog extends Context.Service<
  HobProposalLog,
  {
    /** Records a new proposal with its HobProposalRequested event. */
    readonly insert: (proposal: HobProposal) => Effect.Effect<Committed<HobProposal>>;
    readonly get: (id: HobProposalId) => Effect.Effect<Option.Option<HobProposal>>;
    /** The proposal the manager's call with `key` made, in any of `scopes`. */
    readonly byCall: (
      agentId: AgentId,
      scopes: ReadonlyArray<string>,
      key: string,
    ) => Effect.Effect<Option.Option<HobProposal>>;
    /**
     * Saves `next` with its HobProposalChanged event when the stored proposal is still at `next`'s
     * revision. None, and nothing changed, when it moved on meanwhile, so of two decisions racing for
     * one proposal only the first lands. With `unwaited`, no call waits for a settling any more, so it
     * goes to the manager's backpack in the same transaction (ADR 019).
     */
    readonly move: (
      next: HobProposal,
      options?: { readonly unwaited?: boolean },
    ) => Effect.Effect<Option.Option<Committed<HobProposal>>>;
    /** Every open proposal, oldest first, then the latest `settled` others, newest first. */
    readonly list: (settled: number) => Effect.Effect<ReadonlyArray<HobProposal>>;
  }
>()("@hobbots/agents/HobProposalLog") {}

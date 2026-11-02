import type { AgentId, CharmCall, CharmCallState, MessageId, ThreadId } from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";

/** What recording a call found: it is new and may be sent, or a call already holds its key or its site. */
export type CharmCallStart =
  | { readonly _tag: "Started" }
  /** The hob used this key before: the call it named then, with its result or state. */
  | { readonly _tag: "Existing"; readonly call: CharmCall }
  /** Another call of the same tool on the same site is still being sent or is uncertain. */
  | { readonly _tag: "Blocked"; readonly call: CharmCall };

/**
 * The Charm call records (ADR 020, migration 0028): every Charm write, recorded with its key before
 * anything is sent, so a call the runtime retries is never sent twice, and a call that ended without
 * a clear result is read back before anything else is sent to the same place.
 */
export class CharmCalls extends Context.Service<
  CharmCalls,
  {
    /**
     * Records a call in `sending`, in one transaction with the checks: a call already holding the
     * hob's key is returned instead, unless it was `not-sent` with the same input, which this call
     * replaces; a call of the same tool on the same site that is still `sending` or `uncertain`
     * blocks it.
     */
    readonly begin: (call: CharmCall) => Effect.Effect<CharmCallStart>;
    /**
     * Moves a call that is not yet settled to `state`, with what the hob is told. None when the call
     * is not found or has settled already, so a late outcome never overwrites a settled one.
     */
    readonly settle: (
      agentId: AgentId,
      key: string,
      state: CharmCallState,
      result: string | null,
      at: string,
    ) => Effect.Effect<Option.Option<CharmCall>>;
    readonly find: (agentId: AgentId, key: string) => Effect.Effect<Option.Option<CharmCall>>;
    /** The call shown as this reply step. */
    readonly findByStep: (
      threadId: ThreadId,
      messageId: MessageId,
      stepId: string,
    ) => Effect.Effect<Option.Option<CharmCall>>;
    /** Every call still `sending` or `uncertain`, oldest first, for reading GitHub back. */
    readonly unsettled: Effect.Effect<ReadonlyArray<CharmCall>>;
  }
>()("@hobbots/agents/CharmCalls") {}

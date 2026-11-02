import { CharmCallNotFound, CharmCallSettled, UserSession } from "@hobbots/api";
import type { AgentId, CharmCall, CharmCallState, MessageId, ThreadId } from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";

/** What recording a call found: it is new and may be sent, or a call already holds its key or its site. */
export type CharmCallStart =
  | { readonly _tag: "Started" }
  /** The hob used this key before: the call it named then, with its result or state. */
  | { readonly _tag: "Existing"; readonly call: CharmCall }
  /** Another call of the same tool on the same site is still being sent or is uncertain. */
  | { readonly _tag: "Blocked"; readonly call: CharmCall };

/**
 * The Charm call records (ADR 020, migration 0027): every Charm write, recorded with its key before
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
    /** The thread's calls, oldest first, so its steps can show how each settled. */
    readonly listForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CharmCall>>;
    /** Every call still `sending` or `uncertain`, oldest first, for reading GitHub back. */
    readonly unsettled: Effect.Effect<ReadonlyArray<CharmCall>>;
  }
>()("@hobbots/agents/CharmCalls") {}

/** How the user settles an uncertain call, after looking on GitHub. */
export type CharmCallSettlement = "applied" | "not-sent";

const SETTLED: Record<CharmCallSettlement, string> = {
  applied: "The user looked on GitHub and settled this call as applied.",
  "not-sent": "The user looked on GitHub and settled this call as not sent, so it may be made again.",
};

/**
 * The user's side of the call records (ADR 020): the thread's calls, and settling an uncertain one
 * from its step once they have looked on GitHub. Only the user settles a call: it needs a
 * `UserSession`, which no hob, Charm or runtime tool has (PE-006).
 */
export class CharmCallService extends Context.Service<
  CharmCallService,
  {
    readonly listForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CharmCall>>;
    readonly settle: (
      threadId: ThreadId,
      messageId: MessageId,
      stepId: string,
      outcome: CharmCallSettlement,
    ) => Effect.Effect<CharmCall, CharmCallNotFound | CharmCallSettled, UserSession>;
  }
>()("@hobbots/agents/CharmCallService") {
  static readonly layer = Layer.effect(
    CharmCallService,
    Effect.gen(function* () {
      const calls = yield* CharmCalls;
      return CharmCallService.of({
        listForThread: calls.listForThread,
        settle: (threadId, messageId, stepId, outcome) =>
          Effect.gen(function* () {
            yield* UserSession;
            const found = yield* calls.findByStep(threadId, messageId, stepId);
            if (Option.isNone(found)) return yield* new CharmCallNotFound({ stepId });
            const call = found.value;
            if (call.state !== "uncertain") return yield* new CharmCallSettled({ stepId, state: call.state });
            const at = DateTime.formatIso(yield* DateTime.now);
            const settled = yield* calls.settle(call.agentId, call.key, outcome, SETTLED[outcome], at);
            // Reading GitHub back may have settled it a moment before.
            if (Option.isNone(settled)) {
              const now = yield* calls.find(call.agentId, call.key);
              return yield* new CharmCallSettled({
                stepId,
                state: Option.isSome(now) ? now.value.state : call.state,
              });
            }
            return settled.value;
          }),
      });
    }),
  );
}

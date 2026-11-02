import { CharmCallService, HobbotsRepository } from "@hobbots/agents";
import { CharmCallNotFound, HobbotsApi } from "@hobbots/api";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { forExistingThread } from "./thread-exists.ts";

// Charm calls by the reply steps they showed as, and settling an uncertain one (ADR 020), for user
// sessions only (PE-006).
export const CharmCallsHandlers = HttpApiBuilder.group(HobbotsApi, "charmCalls", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    // A hub without Charms has no calls to show or settle.
    const calls = yield* Effect.serviceOption(CharmCallService);
    return handlers.handleAll({
      forThread: ({ params }) =>
        forExistingThread(
          repo,
          params.threadId,
          Option.isSome(calls) ? calls.value.listForThread(params.threadId) : Effect.succeed([]),
        ),
      settle: ({ params, payload }) =>
        Option.isSome(calls)
          ? calls.value.settle(params.threadId, params.messageId, params.stepId, payload.outcome)
          : Effect.fail(new CharmCallNotFound({ stepId: params.stepId })),
    });
  }),
);

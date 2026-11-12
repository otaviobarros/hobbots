import { CharmCallService, HobbotsRepository } from "@hobbots/agents";
import { CharmCallNotFound, HobbotsApi } from "@hobbots/api";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { forExistingThread } from "./thread-exists.ts";

// Charm calls by the reply steps they showed as, the uncertain ones Tasks made, and settling an
// uncertain one from its step or its Task (ADR 020, ADR 038), for user sessions only (PE-006).
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
          ? calls.value.settle({ _tag: "Step", ...params }, payload.outcome)
          : Effect.fail(new CharmCallNotFound({ ref: params.stepId })),
      waiting: () => (Option.isSome(calls) ? calls.value.waitingOnTasks : Effect.succeed([])),
      settleOnTask: ({ params, payload }) =>
        Option.isSome(calls)
          ? calls.value.settle({ _tag: "Task", ...params }, payload.outcome)
          : Effect.fail(new CharmCallNotFound({ ref: params.attempt })),
    });
  }),
);

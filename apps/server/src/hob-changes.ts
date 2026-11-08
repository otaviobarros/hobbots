import { foundAgent, HobbotsRepository, HobChanges, HobService } from "@hobbots/agents";
import { CHANGES_LOG_LIMIT, HobbotsApi } from "@hobbots/api";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// A hob's History, the Changes log and Revert (ADR 034), for user sessions only (PE-006).
export const HobChangesHandlers = HttpApiBuilder.group(HobbotsApi, "hobChanges", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const hobs = yield* HobService;
    // A hub without change records, as in some tests, has no changes to show.
    const changes = yield* Effect.serviceOption(HobChanges);
    return handlers.handleAll({
      forHob: ({ params }) =>
        repo.findAgent(params.agentId).pipe(
          Effect.flatMap(foundAgent(params.agentId)),
          Effect.flatMap(() => (Option.isSome(changes) ? changes.value.forHob(params.agentId) : Effect.succeed([]))),
        ),
      // One more than the log shows tells whether older changes were left out.
      log: () =>
        (Option.isSome(changes) ? changes.value.latest(CHANGES_LOG_LIMIT + 1) : Effect.succeed([])).pipe(
          Effect.map((found) => ({
            changes: found.slice(0, CHANGES_LOG_LIMIT),
            more: found.length > CHANGES_LOG_LIMIT,
          })),
        ),
      revert: ({ params }) => hobs.revert(params.agentId, params.version),
    });
  }),
);

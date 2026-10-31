import { ChatService, foundAgent, HobbotsRepository, HobService, PermissionSummary } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// A hob's policy with what it adds up to under the installation's current preset and shared folders.
export const PermissionsHandlers = HttpApiBuilder.group(HobbotsApi, "permissions", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const hobs = yield* HobService;
    const chat = yield* ChatService;
    const summary = yield* PermissionSummary;
    return handlers.handleAll({
      get: ({ params }) =>
        repo.findAgent(params.agentId).pipe(Effect.flatMap(foundAgent(params.agentId)), Effect.flatMap(summary.of)),
      // A running turn keeps nothing the new policy takes away (PE-008).
      update: ({ params, payload }) =>
        hobs.updatePolicy(params.agentId, payload).pipe(
          Effect.tap(() => chat.reviewAuthority(params.agentId)),
          Effect.flatMap(summary.of),
        ),
    });
  }),
);

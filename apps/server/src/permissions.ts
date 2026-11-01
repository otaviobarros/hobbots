import {
  ChatService,
  foundAgent,
  GrantService,
  HobbotsRepository,
  HobService,
  PermissionSummary,
  policyLoss,
} from "@hobbots/agents";
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
    const grants = yield* GrantService;
    return handlers.handleAll({
      get: ({ params }) =>
        repo.findAgent(params.agentId).pipe(Effect.flatMap(foundAgent(params.agentId)), Effect.flatMap(summary.of)),
      // The hob's grants that relied on what the new policy takes away are revoked (ADR 015), and a
      // running turn keeps nothing it takes away (PE-008).
      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const before = yield* repo.findAgent(params.agentId).pipe(Effect.flatMap(foundAgent(params.agentId)));
          const after = yield* hobs.updatePolicy(params.agentId, payload);
          yield* grants.revokeLost(params.agentId, policyLoss(before.policy, after.policy));
          yield* chat.reviewAuthority(params.agentId);
          return yield* summary.of(after);
        }),
    });
  }),
);

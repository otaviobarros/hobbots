import {
  CharmDeclarations,
  ChatService,
  changePermissions,
  foundAgent,
  GrantService,
  HobbotsRepository,
  HobService,
  PermissionSummary,
} from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// A hob's policy with what it adds up to under the installation's current preset and shared folders.
export const PermissionsHandlers = HttpApiBuilder.group(HobbotsApi, "permissions", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const hobs = yield* HobService;
    const chat = yield* ChatService;
    const summary = yield* PermissionSummary;
    const grants = yield* GrantService;
    const changed = changePermissions({ repo, grants, chat, charms: yield* CharmDeclarations });
    return handlers.handleAll({
      get: ({ params }) =>
        repo.findAgent(params.agentId).pipe(Effect.flatMap(foundAgent(params.agentId)), Effect.flatMap(summary.of)),
      // The hob's grants that relied on what the new policy takes away, a Charm included, are revoked
      // (ADR 015, ADR 031), and a running turn keeps nothing it takes away (PE-008).
      update: ({ params, payload }) =>
        changed(params.agentId, hobs.updatePolicy(params.agentId, payload)).pipe(Effect.flatMap(summary.of)),
    });
  }),
);

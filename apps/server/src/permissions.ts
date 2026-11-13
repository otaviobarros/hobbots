import {
  CharmDeclarations,
  Charms,
  ChatService,
  changePermissions,
  foundAgent,
  GrantService,
  HobbotsRepository,
  HobService,
  InstallationSettings,
  PermissionSummary,
  reachOf,
  runtimeAdapters,
} from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect, Option } from "effect";
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
    const reach = reachOf({
      repo,
      setup: yield* InstallationSettings,
      adapters: yield* runtimeAdapters,
      charms: Option.match(yield* Effect.serviceOption(Charms), { onNone: () => [], onSome: (each) => each.charms }),
    });
    const found = (agentId: Parameters<typeof foundAgent>[0]) =>
      repo.findAgent(agentId).pipe(Effect.flatMap(foundAgent(agentId)));
    return handlers.handleAll({
      get: ({ params }) => found(params.agentId).pipe(Effect.flatMap(summary.of)),
      // The hob's grants that relied on what the new policy takes away, a Charm included, are revoked
      // (ADR 015, ADR 031), and a running turn keeps nothing it takes away (PE-008). The answer says
      // what the change opens that some of the hob's sessions still do not get (#1347).
      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const before = yield* found(params.agentId);
          const after = yield* changed(params.agentId, hobs.updatePolicy(params.agentId, payload));
          return { ...(yield* summary.of(after)), reach: yield* reach(before, after) };
        }),
    });
  }),
);

import { AgentNotFound, HobbotsApi, type HobPermissions } from "@hobbots/api";
import {
  type Agent,
  type HobPolicy,
  narrowest,
  POLICY_OPERATIONS,
  type PolicyDecision,
  type PolicyOperation,
  PRESET_DECISIONS,
  type SafetyPreset,
} from "@hobbots/domain";
import { HobbotsRepository, SetupRepository } from "@hobbots/persistence";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { sameFolderIn } from "./folders.ts";
import { HobService } from "./hobs.ts";

/**
 * The folders a hob works in: the shared folders it does not hide, then its own (ADR 014). A shared
 * folder is hidden when a hidden entry names the same folder now, whatever spelling either was
 * stored with, so canonicalizing a shared folder later never shows a hidden one again.
 */
export const effectiveFolders = (sharedFolders: ReadonlyArray<string>, policy: HobPolicy) =>
  Effect.gen(function* () {
    const isHidden = yield* sameFolderIn(policy.hiddenSharedFolders);
    const visible = yield* Effect.filter(sharedFolders, (folder) => Effect.map(isHidden(folder), (hidden) => !hidden));
    return [...new Set([...visible, ...policy.ownFolders])];
  });

/**
 * Per operation, the narrower of the preset and the hob's override. Taking the narrower one keeps an
 * override stored under one preset from widening a stricter preset picked later.
 */
export const effectiveDecisions = (
  preset: SafetyPreset,
  overrides: HobPolicy["overrides"],
): Record<PolicyOperation, PolicyDecision> =>
  Object.fromEntries(
    POLICY_OPERATIONS.map((operation) => {
      const override = overrides[operation];
      const answer = PRESET_DECISIONS[preset][operation];
      return [operation, override === undefined ? answer : narrowest(answer, override)];
    }),
  ) as Record<PolicyOperation, PolicyDecision>;

// A hob's policy with what it adds up to under the installation's current preset and shared folders.
export const PermissionsHandlers = HttpApiBuilder.group(HobbotsApi, "permissions", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const setup = yield* SetupRepository;
    const hobs = yield* HobService;
    const permissions = (agent: Agent) =>
      Effect.gen(function* () {
        const { safetyPreset, approvedFolders } = yield* setup.get;
        return {
          agentId: agent.id,
          configVersion: agent.configVersion,
          preset: safetyPreset,
          sharedFolders: approvedFolders,
          policy: agent.policy,
          folders: yield* effectiveFolders(approvedFolders, agent.policy),
          decisions: effectiveDecisions(safetyPreset, agent.policy.overrides),
        } satisfies HobPermissions;
      });
    return handlers.handleAll({
      get: ({ params }) =>
        repo.findAgent(params.agentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new AgentNotFound({ agentId: params.agentId })),
              onSome: permissions,
            }),
          ),
        ),
      update: ({ params, payload }) => hobs.updatePolicy(params.agentId, payload).pipe(Effect.flatMap(permissions)),
    });
  }),
);

import type { HobPermissions } from "@hobbots/api";
import { AgentNotFound } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  type AnyOperation,
  type CharmDeclaration,
  type CharmOperation,
  declaredOperations,
  EMPTY_HOB_POLICY,
  effectiveDecision,
  type HobPolicy,
  hobAnswers,
  POLICY_OPERATIONS,
  type PolicyDecision,
  type SafetyPreset,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import type { ChatService } from "./chat.ts";
import { sameFolderIn } from "./folders.ts";
import { CharmDeclarations, type GrantService, policyLoss } from "./grants.ts";
import { FolderChecks, type FolderChecksShape, InstallationSettings } from "./ports.ts";
import type { HobbotsRepository } from "./repository.ts";
import { missingRuntimeHealth, runtimeAdapters } from "./runtime.ts";

/**
 * The folders a hob works in: the shared folders it does not hide, then its own (ADR 014). A shared
 * folder is hidden when a hidden entry names the same folder now, whatever spelling either was
 * stored with, so canonicalizing a shared folder later never shows a hidden one again.
 */
export const effectiveFolders = (folders: FolderChecksShape, sharedFolders: ReadonlyArray<string>, policy: HobPolicy) =>
  Effect.gen(function* () {
    const isHidden = yield* sameFolderIn(folders, policy.hiddenSharedFolders);
    const visible = yield* Effect.filter(sharedFolders, (folder) => Effect.map(isHidden(folder), (hidden) => !hidden));
    return [...new Set([...visible, ...policy.ownFolders])];
  });

/** The folders a hob works in now, each as the hub finds it now (canonical while it is there), once. */
export const hobFoldersNow = (folders: FolderChecksShape, sharedFolders: ReadonlyArray<string>, policy: HobPolicy) =>
  Effect.flatMap(effectiveFolders(folders, sharedFolders, policy), (each) =>
    Effect.map(Effect.forEach(each, folders.identity), (canonical) => [...new Set(canonical)]),
  );

/**
 * Per operation, built-in or declared by a Charm the hub holds, the narrower of the preset and the
 * hob's override. Taking the narrower one keeps an override stored under one preset from widening a
 * stricter preset picked later.
 */
const effectiveDecisions = (
  preset: SafetyPreset,
  policy: HobPolicy,
  charmOperations: ReadonlyArray<CharmOperation>,
): Record<AnyOperation, PolicyDecision> => {
  const answers = hobAnswers(policy);
  return Object.fromEntries(
    [...POLICY_OPERATIONS, ...charmOperations.map((operation) => operation.id)].map((operation) => [
      operation,
      effectiveDecision(preset, answers, operation, charmOperations),
    ]),
  ) as Record<AnyOperation, PolicyDecision>;
};

/**
 * A hob's policy with what it adds up to under the installation's current preset and shared folders,
 * and what its runtime enforces on this hub, so the profile never shows an unheld rule as safe (PE-005).
 */
export class PermissionSummary extends Context.Service<
  PermissionSummary,
  { readonly of: (agent: Agent) => Effect.Effect<HobPermissions> }
>()("@hobbots/agents/PermissionSummary") {
  static readonly layer = Layer.effect(
    PermissionSummary,
    Effect.gen(function* () {
      const setup = yield* InstallationSettings;
      const folders = yield* FolderChecks;
      const adapters = yield* runtimeAdapters;
      const charmOperations = declaredOperations(yield* CharmDeclarations);
      return PermissionSummary.of({
        of: (agent) =>
          Effect.gen(function* () {
            const { safetyPreset, approvedFolders } = yield* setup.get;
            return {
              agentId: agent.id,
              configVersion: agent.configVersion,
              preset: safetyPreset,
              sharedFolders: approvedFolders,
              policy: agent.policy,
              folders: yield* effectiveFolders(folders, approvedFolders, agent.policy),
              decisions: effectiveDecisions(safetyPreset, agent.policy, charmOperations),
              presets: effectiveDecisions(safetyPreset, EMPTY_HOB_POLICY, charmOperations),
              // What the hob's own runtime enforces; a thread on another brain runs under that one's.
              enforcement: yield* adapters(agent.runtime)?.enforcement ??
                Effect.succeed(missingRuntimeHealth(agent.runtime).enforcement),
            } satisfies HobPermissions;
          }),
      });
    }),
  );
}

/**
 * Writes a change to a hob's permissions with `write`, then takes back what it took away: the
 * hob's grants that relied on it are revoked (ADR 015, ADR 031), and a running turn keeps nothing
 * it took away (PE-008). The Charms tab and the Summoning Charm change permissions through it alike.
 */
export const changePermissions =
  (services: {
    readonly repo: HobbotsRepository["Service"];
    readonly grants: GrantService["Service"];
    readonly chat: ChatService["Service"];
    readonly charms: ReadonlyArray<CharmDeclaration>;
  }) =>
  <E>(agentId: AgentId, write: Effect.Effect<Agent, E>): Effect.Effect<Agent, E | AgentNotFound> =>
    Effect.gen(function* () {
      const before = yield* services.repo.findAgent(agentId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new AgentNotFound({ agentId })),
            onSome: Effect.succeed,
          }),
        ),
      );
      const after = yield* write;
      yield* services.grants.revokeLost(agentId, policyLoss(before.policy, after.policy, services.charms));
      yield* services.chat.reviewAuthority(agentId);
      return after;
    });

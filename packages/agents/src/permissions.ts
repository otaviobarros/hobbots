import type { HobPermissions } from "@hobbots/api";
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
import { Context, Effect, Layer } from "effect";
import { sameFolderIn } from "./folders.ts";
import { FolderChecks, type FolderChecksShape, InstallationSettings } from "./ports.ts";
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

/**
 * Per operation, the narrower of the preset and the hob's override. Taking the narrower one keeps an
 * override stored under one preset from widening a stricter preset picked later.
 */
const effectiveDecisions = (
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
              decisions: effectiveDecisions(safetyPreset, agent.policy.overrides),
              // What the hob's own runtime enforces; a thread on another brain runs under that one's.
              enforcement: yield* adapters(agent.runtime)?.enforcement ??
                Effect.succeed(missingRuntimeHealth(agent.runtime).enforcement),
            } satisfies HobPermissions;
          }),
      });
    }),
  );
}

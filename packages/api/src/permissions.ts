import {
  AgentId,
  AnyOperation,
  ConfigVersion,
  HobCharms,
  HobPolicy,
  PolicyDecision,
  PolicyOverrides,
  RuntimeEnforcement,
  SafetyPreset,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, InvalidFolder, OverrideWidens, UndeclaredOperation, UnknownCharm } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * What a hob may touch (ADR 014): its stored policy, and what it adds up to under the installation's
 * current preset and shared folders.
 */
export const HobPermissions = Schema.Struct({
  agentId: AgentId,
  /** The configuration version the policy belongs to. */
  configVersion: ConfigVersion,
  preset: SafetyPreset,
  /** The folders every hob can work in, from setup. */
  sharedFolders: Schema.Array(Schema.String),
  policy: HobPolicy,
  /** The shared folders the hob does not hide, then its own. */
  folders: Schema.Array(Schema.String),
  /**
   * Per operation, the narrower of the preset and the hob's override: every built-in one, and every
   * one the Charms the hub holds declare (ADR 031), by its id.
   */
  decisions: Schema.Record(AnyOperation, PolicyDecision),
  /** Per operation, the preset's own answer, which an override may only narrow. */
  presets: Schema.Record(AnyOperation, PolicyDecision),
  /**
   * What the hob's runtime enforces on this hub. Where the process sandbox is unsupported, commands,
   * local Git and the web are blocked whatever the decisions say.
   */
  enforcement: RuntimeEnforcement,
});
export type HobPermissions = typeof HobPermissions.Type;

/**
 * A change to a hob's policy; fields left out keep their value, and the ones given replace it. Own
 * folders are paths on the hub, absolute or starting with `~`, stored canonical. A hidden folder
 * must be one of the shared folders. An override may only narrow the preset. Signing and the Charms
 * are the user's own grants, so they may widen. Each change that changes something becomes the hob's
 * next configuration version.
 */
export const UpdateHobPermissionsPayload = Schema.Struct({
  ownFolders: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  hiddenSharedFolders: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  overrides: Schema.optionalKey(PolicyOverrides),
  /**
   * The Charms granted to the hob, and its overrides for their operations, keyed by id (ADR 031).
   * Each granted id must be a Charm the hub holds. Each override must be an operation such a Charm
   * declares, and may only narrow its preset answer. A field left out keeps its value.
   */
  charms: Schema.optionalKey(HobCharms),
  /** Whether the hob signs commits with the user's 1Password SSH key, which also opens SSH logins. */
  signCommits: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether the hob has the GitHub Charm (ADR 020), as clients asked before the Charm-id grant (ADR
   * 031): on adds `github` to the hob's Charms, off takes it away. `charms.granted` wins when both are given.
   */
  githubCharm: Schema.optionalKey(Schema.Boolean),
});
export type UpdateHobPermissionsPayload = typeof UpdateHobPermissionsPayload.Type;

export class PermissionsGroup extends HttpApiGroup.make("permissions")
  .add(
    HttpApiEndpoint.get("get", "/agents/:agentId/permissions", {
      params: { agentId: AgentId },
      success: HobPermissions,
      error: AgentNotFound,
    }),
    HttpApiEndpoint.patch("update", "/agents/:agentId/permissions", {
      params: { agentId: AgentId },
      payload: UpdateHobPermissionsPayload,
      success: HobPermissions,
      error: [AgentNotFound, InvalidFolder, OverrideWidens, UndeclaredOperation, UnknownCharm],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

import {
  AgentId,
  ConfigVersion,
  HobPolicy,
  PolicyDecision,
  PolicyOperation,
  PolicyOverrides,
  SafetyPreset,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, InvalidFolder, OverrideWidens } from "./errors.ts";

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
  /** Per operation, the narrower of the preset and the hob's override. */
  decisions: Schema.Record(PolicyOperation, PolicyDecision),
});
export type HobPermissions = typeof HobPermissions.Type;

/**
 * A change to a hob's policy; fields left out keep their value, and the ones given replace it. Own
 * folders are paths on the hub, absolute or starting with `~`, stored canonical. A hidden folder
 * must be one of the shared folders. An override may only narrow the preset. Each change that
 * changes something becomes the hob's next configuration version.
 */
export const UpdateHobPermissionsPayload = Schema.Struct({
  ownFolders: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  hiddenSharedFolders: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  overrides: Schema.optionalKey(PolicyOverrides),
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
      error: [AgentNotFound, InvalidFolder, OverrideWidens],
    }),
  )
  .prefix("/api") {}

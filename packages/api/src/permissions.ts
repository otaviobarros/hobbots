import {
  AgentId,
  AnyOperation,
  CharmId,
  ConfigVersion,
  HobCharms,
  HobPolicy,
  PolicyDecision,
  PolicyOverrides,
  RuntimeEnforcement,
  RuntimeKind,
  SafetyPreset,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  AgentNotFound,
  InvalidFolder,
  OverrideWidens,
  UndeclaredOperation,
  UnknownCharm,
  UnofferedAnswer,
} from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * What a change to a hob's permissions opens that some of its sessions still do not get, though it
 * applies from the hob's next turn (#1347). Empty lists when the change reaches every session.
 */
export const ChangeReach = Schema.Struct({
  /**
   * Charms whose writes the change opens, which a session outside any chat, a party member's or a
   * step's, is still not offered, since such a Charm offers its writes only in chats (ADR 038).
   */
  chatsOnly: Schema.Array(CharmId),
  /**
   * What only a session started after the change gets, on a runtime that resumes a session with the
   * hub tools it started with, as Codex's does (#1245). Empty when none of the hob's sessions runs on
   * such a runtime, or the change offers no new hub tool.
   */
  newSessionsOnly: Schema.Struct({
    /** The runtimes, among the hob's own and its chats' brains, whose sessions keep their tools. */
    runtimes: Schema.Array(RuntimeKind),
    /** The Charms the change grants, whose tools a chat or Task started before does not get. */
    charms: Schema.Array(CharmId),
    /** The answers the change opens from Never whose hub tools a chat or Task started before does not get. */
    operations: Schema.Array(AnyOperation),
    /**
     * The Charm writes the change opens from Never, which a chat was offered already but a Task
     * session is offered only once they are not Never (ADR 038), so a Task started before does not get them.
     */
    taskOperations: Schema.Array(AnyOperation),
  }),
});
export type ChangeReach = typeof ChangeReach.Type;

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
  /** On the answer to a change only: what it opens that some of the hob's sessions still do not get. */
  reach: Schema.optionalKey(ChangeReach),
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
      error: [AgentNotFound, InvalidFolder, OverrideWidens, UndeclaredOperation, UnknownCharm, UnofferedAnswer],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

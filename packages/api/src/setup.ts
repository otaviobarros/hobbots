import { InstallationSetup, RuntimeKind, SafetyPreset, SettingChange, SummoningForEveryHob } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { InvalidFolder, UndeclaredOperation } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * A change to the installation's setup; fields left out keep their value. Setup can be completed
 * but not reopened, and the folders and connected providers replace the stored lists. A folder is
 * a path on the hub, absolute or starting with `~`; the hub stores it resolved.
 */
export const UpdateSetupPayload = Schema.Struct({
  completed: Schema.optionalKey(Schema.Literal(true)),
  safetyPreset: Schema.optionalKey(SafetyPreset),
  approvedFolders: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  connectedProviders: Schema.optionalKey(Schema.Array(RuntimeKind)),
  /**
   * "Summoning for every hob" (ADR 034): the Summoning Charm for every hob you made, with one scope
   * and set of answers, or null for off. Turning it on writes the Charm's default answers under any
   * the change leaves out. Each answer must be one of the Summoning Charm's operations.
   */
  summoningForEveryHob: Schema.optionalKey(Schema.NullOr(SummoningForEveryHob)),
});
export type UpdateSetupPayload = typeof UpdateSetupPayload.Type;

/** How many of the newest setting changes Settings › Changes reads at most. */
export const SETTING_CHANGES_LIMIT = 500;

/** The newest changes to the settings that change what hobs may do (#1357), and whether older ones were left out. */
export const SettingChangesLog = Schema.Struct({
  changes: Schema.Array(SettingChange),
  more: Schema.Boolean,
});
export type SettingChangesLog = typeof SettingChangesLog.Type;

export class SetupGroup extends HttpApiGroup.make("setup")
  .add(
    HttpApiEndpoint.get("get", "/setup", { success: InstallationSetup }),
    HttpApiEndpoint.patch("update", "/setup", {
      payload: UpdateSetupPayload,
      success: InstallationSetup,
      error: [InvalidFolder, UndeclaredOperation],
    }),
    HttpApiEndpoint.get("changes", "/setup/changes", { success: SettingChangesLog }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

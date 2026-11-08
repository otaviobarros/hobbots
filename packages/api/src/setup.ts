import { InstallationSetup, RuntimeKind, SafetyPreset, SummoningForEveryHob } from "@hobbots/domain";
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

export class SetupGroup extends HttpApiGroup.make("setup")
  .add(
    HttpApiEndpoint.get("get", "/setup", { success: InstallationSetup }),
    HttpApiEndpoint.patch("update", "/setup", {
      payload: UpdateSetupPayload,
      success: InstallationSetup,
      error: [InvalidFolder, UndeclaredOperation],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

import { InstallationSetup, SafetyPreset } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/**
 * A change to the installation's setup; fields left out keep their value. Setup can be completed
 * but not reopened, and the folders replace the stored list.
 */
export const UpdateSetupPayload = Schema.Struct({
  completed: Schema.optionalKey(Schema.Literal(true)),
  safetyPreset: Schema.optionalKey(SafetyPreset),
  approvedFolders: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});
export type UpdateSetupPayload = typeof UpdateSetupPayload.Type;

export class SetupGroup extends HttpApiGroup.make("setup")
  .add(
    HttpApiEndpoint.get("get", "/setup", { success: InstallationSetup }),
    HttpApiEndpoint.patch("update", "/setup", { payload: UpdateSetupPayload, success: InstallationSetup }),
  )
  .prefix("/api") {}

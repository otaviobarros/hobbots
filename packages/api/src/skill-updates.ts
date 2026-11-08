import { SkillId, SkillRevisionHash, SkillUpdate, SkillUpdateProblem } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { importErrors, RevisedSkill, SkillMissing } from "./skills.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * Updates from a source (ADR 029, Updates from a source): what the checks of the library's Git sources
 * found, Check now, and your decisions. Accept adds an update as a new revision and rolls it out like
 * your own edit. A check changes the library only for a skill set to Update automatically, whose clean
 * updates it accepts and rolls out by their source. Only a user session decides.
 */

/**
 * Skills › Updates: every update that waits for you, by skill name, the skills set to Update
 * automatically, and the last check, with the sources it could not read.
 */
export const SkillUpdatesView = Schema.Struct({
  updates: Schema.Array(SkillUpdate),
  automatic: Schema.Array(SkillId),
  checkedAt: Schema.NullOr(Schema.String),
  problems: Schema.Array(SkillUpdateProblem),
});
export type SkillUpdatesView = typeof SkillUpdatesView.Type;

/** What Check now found, and the skills set to Update automatically that it updated by itself. */
export const SkillUpdatesChecked = Schema.Struct({
  ...SkillUpdatesView.fields,
  updated: Schema.Array(SkillId),
});
export type SkillUpdatesChecked = typeof SkillUpdatesChecked.Type;

const skillParams = { skillId: SkillId };

export class SkillUpdatesGroup extends HttpApiGroup.make("skillUpdates")
  .add(HttpApiEndpoint.get("list", "/skill-updates", { success: SkillUpdatesView }))
  .add(
    // Checks every Git source now, as the daily check does.
    HttpApiEndpoint.post("check", "/skill-updates/check", { success: SkillUpdatesChecked }),
  )
  .add(
    // Accepts the update of `hash` as reviewed against `base`: a new revision, rolled out to every
    // assignment that is not held. A review compared with another revision since is refused as stale.
    HttpApiEndpoint.post("accept", "/skill-updates/:skillId/accept", {
      params: skillParams,
      payload: Schema.Struct({ hash: SkillRevisionHash, base: SkillRevisionHash }),
      success: RevisedSkill,
      error: importErrors,
    }),
  )
  .add(
    // Not now: the update of `hash` leaves Updates until the source changes again.
    HttpApiEndpoint.post("dismiss", "/skill-updates/:skillId/dismiss", {
      params: skillParams,
      payload: Schema.Struct({ hash: SkillRevisionHash }),
      success: SkillUpdatesView,
      error: SkillMissing,
    }),
  )
  .add(
    // Update automatically, for a skill from Git.
    HttpApiEndpoint.put("automatic", "/skill-updates/:skillId/automatic", {
      params: skillParams,
      payload: Schema.Struct({ on: Schema.Boolean }),
      success: SkillUpdatesView,
      error: SkillMissing,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

import { Agent, AgentId, HobChange } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, InvalidFolder, InvalidHob, RevertRefused } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/** How many of the newest changes the Changes log reads at most. */
export const CHANGES_LOG_LIMIT = 500;

/** The newest changes across every hob, and whether older ones were left out. */
export const ChangesLog = Schema.Struct({
  changes: Schema.Array(HobChange),
  more: Schema.Boolean,
});
export type ChangesLog = typeof ChangesLog.Type;

/**
 * Every change to a hob, with who made it (ADR 034), for its History and the Changes log, and Revert
 * for its latest change. Only a user session reaches it (PE-006), so a revert is always yours.
 */
export class HobChangesGroup extends HttpApiGroup.make("hobChanges")
  .add(
    // The hob's changes, newest first; a retired hob's too.
    HttpApiEndpoint.get("forHob", "/agents/:agentId/changes", {
      params: { agentId: AgentId },
      success: Schema.Array(HobChange),
      error: AgentNotFound,
    }),
    // The newest changes across every hob, newest first.
    HttpApiEndpoint.get("log", "/hob-changes", { success: ChangesLog }),
    // Reverts the hob's latest change, `version`, as its next version.
    HttpApiEndpoint.post("revert", "/agents/:agentId/versions/:version/revert", {
      params: { agentId: AgentId, version: Schema.NumberFromString.check(Schema.isInt()) },
      success: Agent,
      error: [AgentNotFound, InvalidHob, InvalidFolder, RevertRefused],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

import { ApiError } from "../../api/client.ts";

/** Why adding a hob or taking one out failed, as the sheet says it. */
export type MemberError = "archived" | "hob-unavailable" | "leads-quest" | "refused" | "unreachable";

export const memberError = (error: unknown): MemberError => {
  if (!(error instanceof ApiError)) return "unreachable";
  // Archived since the sheet was read: no change helps until the camp is brought back.
  if (error.tag === "ChannelArchived") return "archived";
  if (error.tag === "HobUnavailable" || error.tag === "AgentNotFound") return "hob-unavailable";
  if (error.tag !== "MembershipRefused") return "unreachable";
  return error.fields["reason"] === "leads-quest" ? "leads-quest" : "refused";
};

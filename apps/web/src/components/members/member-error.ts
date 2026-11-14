import { ApiError } from "../../api/client.ts";

/** Why adding a hob or taking one out failed, as the sheet says it. */
export type MemberError = "hob-unavailable" | "leads-quest" | "refused" | "unreachable";

export const memberError = (error: unknown): MemberError => {
  if (!(error instanceof ApiError)) return "unreachable";
  if (error.tag === "HobUnavailable" || error.tag === "AgentNotFound") return "hob-unavailable";
  if (error.tag !== "MembershipRefused") return "unreachable";
  return error.fields["reason"] === "leads-quest" ? "leads-quest" : "refused";
};

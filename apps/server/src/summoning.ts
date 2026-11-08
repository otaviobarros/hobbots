import { sep } from "node:path";
import { makeSummoningCharm } from "@hobbots/agents";
import { decideHubCall, PolicyEngine } from "@hobbots/permissions";
import { Effect } from "effect";

/**
 * The Summoning Charm (ADR 034), registered with the other Charms. Each operation a call names is
 * decided by the policy engine on the hob's answers with its live grants, as every Charm call is, and
 * the hob's own paths divide at the hub's separator alone (STD-SEC-003).
 */
export const SummoningCharm = Effect.gen(function* () {
  const engine = yield* PolicyEngine;
  return yield* makeSummoningCharm({
    decide: (approvals, base, request) => decideHubCall(engine, approvals, base, request),
    separator: sep === "\\" ? "\\" : "/",
  });
});

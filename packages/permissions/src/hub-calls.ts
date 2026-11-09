import type { Grant } from "@hobbots/domain";
import { Effect } from "effect";
import type { PolicyContext, PolicyEngine, PolicyRequest, PolicyVerdict } from "./engine.ts";

/** A hob's tool access as a hub tool call is decided under it: its policy, without what only a runtime knows. */
export interface HubCallAccess {
  readonly policy: Omit<PolicyContext, "sandbox" | "modelHosts" | "hubHosts" | "grants">;
}

/**
 * Decides a hub tool call, such as a Charm write or a memory tool's, on the hob's answers, with its
 * live grants read again each time (ADR 014): the hub runs it outside the sandbox, so neither the
 * sandbox nor the model's hosts hold the rule. `fresh` is the hob's access after an approval, or null
 * for the turn's own, `base`.
 */
export const decideHubCall =
  (engine: PolicyEngine["Service"], approvals: TurnState | null, base: HubCallAccess, request: PolicyRequest) =>
  (fresh: HubCallAccess | null): Effect.Effect<PolicyVerdict> =>
    Effect.gen(function* () {
      const access = fresh ?? base;
      const grants = approvals ? yield* approvals.grants : [];
      const readWeb = yield* sessionReadWeb(approvals);
      return yield* engine.decide({ ...access.policy, sandbox: "on", modelHosts: [], grants, readWeb }, request);
    });

/**
 * What a turn's calls are decided with besides the policy, read again for every call: the hob's live
 * grants, and the read-the-web mark of its session (ADR 036), which the hub keeps.
 */
export interface TurnState {
  readonly grants: Effect.Effect<ReadonlyArray<Grant>>;
  readonly webMark?: { readonly current: Effect.Effect<unknown> } | undefined;
}

/** Whether the turn's session has read the web now: its mark, read for this call. */
export const sessionReadWeb = (state: TurnState | null | undefined): Effect.Effect<boolean> =>
  state?.webMark === undefined
    ? Effect.succeed(false)
    : Effect.map(state.webMark.current, (mark) => mark !== null && mark !== undefined);

import { HobProposals } from "@hobbots/agents";
import { HobbotsApi, HobProposalMissing } from "@hobbots/api";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/**
 * Hob proposals over HTTP (ADR 034, Asking is a proposal): what waits for you, and your decisions,
 * which `HobProposals` makes under your session. Without the Summoning Charm, nothing waits.
 */
export const HobProposalsHandlers = HttpApiBuilder.group(HobbotsApi, "hobProposals", (handlers) =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(HobProposals);
    if (Option.isNone(found)) {
      const none = ({ params }: { readonly params: { readonly proposalId: string } }) =>
        Effect.fail(new HobProposalMissing({ proposalId: params.proposalId }));
      return handlers.handleAll({
        list: () => Effect.succeed({ proposals: [] }),
        get: none,
        allow: none,
        deny: none,
        allowAll: none,
        denyAll: none,
        alwaysAllow: none,
      });
    }
    const proposals = found.value;
    return handlers.handleAll({
      list: () => Effect.map(proposals.list, (all) => ({ proposals: all })),
      get: ({ params }) => proposals.get(params.proposalId),
      allow: ({ params, payload }) =>
        proposals.allow(params.proposalId, params.rowId, { edited: payload.edited, confirmed: payload.confirmed }),
      deny: ({ params }) => proposals.deny(params.proposalId, params.rowId),
      allowAll: ({ params, payload }) => proposals.allowAll(params.proposalId, { confirmed: payload.confirmed }),
      denyAll: ({ params }) => proposals.denyAll(params.proposalId),
      alwaysAllow: ({ params, payload }) => proposals.alwaysAllow(params.proposalId, payload.operations),
    });
  }),
);

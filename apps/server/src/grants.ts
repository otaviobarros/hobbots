import { GrantService } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// Standing grants and removing them (ADR 015). The next call a removed grant matched asks again.
export const GrantsHandlers = HttpApiBuilder.group(HobbotsApi, "grants", (handlers) =>
  Effect.gen(function* () {
    const grants = yield* GrantService;
    return handlers.handleAll({
      list: ({ query }) => grants.list({ agentId: query.agentId, all: query.include === "all" }),
      revoke: ({ params }) => grants.revoke(params.grantId),
    });
  }),
);

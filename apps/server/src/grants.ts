import { ChatService, GrantService } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// Standing grants and removing them (ADR 015). The next call a removed grant matched asks again.
export const GrantsHandlers = HttpApiBuilder.group(HobbotsApi, "grants", (handlers) =>
  Effect.gen(function* () {
    const grants = yield* GrantService;
    const chat = yield* ChatService;
    return handlers.handleAll({
      list: ({ query }) => grants.list({ agentId: query.agentId, all: query.include === "all" }),
      // A host grant may already have opened the sandbox proxy for running turns, so they stop (ADR 015).
      // File, command and push grants are decided call by call, so the next call asks again.
      revoke: ({ params }) =>
        grants.revoke(params.grantId, (grant) =>
          grant.rule._tag === "Host" ? chat.interruptAgent(grant.agentId) : Effect.void,
        ),
    });
  }),
);

import { ApprovalService, HobbotsRepository } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { forExistingChannel } from "./channel-exists.ts";

// Tool calls waiting for the user's decision, and the decisions (PE-003), for user sessions only (PE-006).
export const ApprovalsHandlers = HttpApiBuilder.group(HobbotsApi, "approvals", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const approvals = yield* ApprovalService;
    return handlers.handleAll({
      forChannel: ({ params }) =>
        forExistingChannel(repo, params.channelId, approvals.listForChannel(params.channelId)),
      list: () => approvals.listInbox,
      get: ({ params }) => approvals.get(params.approvalId),
      decide: ({ params, payload }) => approvals.decide(params.approvalId, payload),
    });
  }),
);

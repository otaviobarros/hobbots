import { ApprovalService, HobbotsRepository, HobService, saveAlwaysAllow } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import type { ApprovalRequest } from "@hobbots/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { forExistingChannel } from "./channel-exists.ts";

// Tool calls waiting for the user's decision, and the decisions (PE-003), for user sessions only (PE-006).
export const ApprovalsHandlers = HttpApiBuilder.group(HobbotsApi, "approvals", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const approvals = yield* ApprovalService;
    const hobs = yield* HobService;
    // Always allow on an Ask that names nothing narrower sets the hob's own answer once the call is
    // approved (ADR 041). A hob that cannot take it keeps its answer: the call it approved still runs.
    const allowAlways = (approval: ApprovalRequest) =>
      saveAlwaysAllow(approval).pipe(
        Effect.provideService(HobbotsRepository, repo),
        Effect.provideService(HobService, hobs),
        Effect.catch((error) => Effect.logWarning("Always allow did not save the hob's answer", error)),
      );
    return handlers.handleAll({
      forChannel: ({ params }) =>
        forExistingChannel(repo, params.channelId, approvals.listForChannel(params.channelId)),
      list: () => approvals.listInbox,
      get: ({ params }) => approvals.get(params.approvalId),
      decide: ({ params, payload }) => Effect.tap(approvals.decide(params.approvalId, payload), allowAlways),
    });
  }),
);

import { ApprovalService, HobbotsRepository, HobService, saveAlwaysAllow } from "@hobbots/agents";
import { type DecideApprovalPayload, HobbotsApi } from "@hobbots/api";
import type { ApprovalId } from "@hobbots/domain";
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
    // approved (ADR 041), only by the decision that settles the request: a retried decision returns
    // the request as decided and changes no answer set since. A hob that cannot take it keeps its
    // answer: the call it approved still runs.
    const decide = (id: ApprovalId, payload: DecideApprovalPayload) =>
      Effect.gen(function* () {
        const before = yield* approvals.get(id);
        const decided = yield* approvals.decide(id, payload);
        if (before.state !== "pending") return decided;
        yield* saveAlwaysAllow(decided).pipe(
          Effect.provideService(HobService, hobs),
          Effect.catch((error) => Effect.logWarning("Always allow did not save the hob's answer", error)),
        );
        return decided;
      });
    return handlers.handleAll({
      forChannel: ({ params }) =>
        forExistingChannel(repo, params.channelId, approvals.listForChannel(params.channelId)),
      list: () => approvals.listInbox,
      get: ({ params }) => approvals.get(params.approvalId),
      decide: ({ params, payload }) => decide(params.approvalId, payload),
    });
  }),
);

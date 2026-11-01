import { ApprovalService, HobbotsRepository } from "@hobbots/agents";
import { HobbotsApi, ThreadNotFound } from "@hobbots/api";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { UserSessionOnlyLive } from "./user-session.ts";

// Tool calls waiting for the user's decision, and the decisions (PE-003), for user sessions only (PE-006).
export const ApprovalsHandlers = HttpApiBuilder.group(HobbotsApi, "approvals", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const approvals = yield* ApprovalService;
    return handlers.handleAll({
      forThread: ({ params }) =>
        repo
          .findThread(params.threadId)
          .pipe(
            Effect.flatMap((thread) =>
              Option.isNone(thread)
                ? Effect.fail(new ThreadNotFound({ threadId: params.threadId }))
                : approvals.listForThread(params.threadId),
            ),
          ),
      list: () => approvals.listInbox,
      get: ({ params }) => approvals.get(params.approvalId),
      decide: ({ params, payload }) => approvals.decide(params.approvalId, payload),
    });
  }),
).pipe(Layer.provide(UserSessionOnlyLive));

import { ClaimRegister } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// The open clashes a chat or camp shows as a Heads-up (ADR 037, #1390), for user sessions only
// (PE-006). A hub built without the claims register, as in some tests, has no clashes to show.
export const ClaimsHandlers = HttpApiBuilder.group(HobbotsApi, "claims", (handlers) =>
  Effect.gen(function* () {
    const register = yield* Effect.serviceOption(ClaimRegister);
    return handlers.handleAll({
      clashes: ({ params }) =>
        Option.match(register, {
          onNone: () => Effect.succeed([]),
          onSome: (claims) => claims.clashesIn(params.threadId),
        }),
    });
  }),
);

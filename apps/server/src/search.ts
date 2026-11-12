import { askFromRecords, byRule, FindIndex, HubDecider } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { FIND_KINDS } from "@hobbots/domain";
import { SearchIndex } from "@hobbots/persistence";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

export const SearchHandlers = HttpApiBuilder.group(HobbotsApi, "search", (handlers) =>
  Effect.gen(function* () {
    const index = yield* SearchIndex;
    const find = yield* FindIndex;
    // Ask asks the hub's brain when the hub has one; without it every answer is the rule's (No AI).
    const decider = Option.getOrElse(yield* Effect.serviceOption(HubDecider), () =>
      HubDecider.of({ decide: (judgment) => Effect.succeed(byRule(judgment)) }),
    );
    return handlers.handleAll({
      search: ({ query }) => index.search(query.q),
      find: ({ query }) =>
        find.find(query.q, { in: query.in ?? null, kinds: query.kind === undefined ? FIND_KINDS : [query.kind] }),
      ask: ({ payload }) =>
        askFromRecords(payload.question, { in: payload.in }).pipe(
          Effect.provideService(FindIndex, find),
          Effect.provideService(HubDecider, decider),
        ),
    });
  }),
);

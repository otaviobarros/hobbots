import { HobbotsApi } from "@hobbots/api";
import { SearchIndex } from "@hobbots/persistence";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

export const SearchHandlers = HttpApiBuilder.group(HobbotsApi, "search", (handlers) =>
  Effect.gen(function* () {
    const index = yield* SearchIndex;
    return handlers.handleAll({ search: ({ query }) => index.search(query.q) });
  }),
);

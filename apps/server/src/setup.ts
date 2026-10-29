import { HobbotsApi } from "@hobbots/api";
import { SetupRepository } from "@hobbots/persistence";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

export const SetupHandlers = HttpApiBuilder.group(HobbotsApi, "setup", (handlers) =>
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    return handlers.handleAll({
      get: () => setup.get,
      // A folder added twice is kept once, where it was first added.
      update: ({ payload }) =>
        setup.update(
          payload.approvedFolders === undefined
            ? payload
            : { ...payload, approvedFolders: [...new Set(payload.approvedFolders)] },
        ),
    });
  }),
);

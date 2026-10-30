import { HobbotsApi } from "@hobbots/api";
import { SetupRepository } from "@hobbots/persistence";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

export const SetupHandlers = HttpApiBuilder.group(HobbotsApi, "setup", (handlers) =>
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    return handlers.handleAll({
      get: () => setup.get,
      // A folder or provider added twice is kept once, where it was first added.
      update: ({ payload }) =>
        setup.update({
          ...payload,
          ...(payload.approvedFolders && { approvedFolders: [...new Set(payload.approvedFolders)] }),
          ...(payload.connectedProviders && { connectedProviders: [...new Set(payload.connectedProviders)] }),
        }),
    });
  }),
);

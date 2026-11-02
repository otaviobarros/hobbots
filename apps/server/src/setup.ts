import { ChatService, GrantService, setupLoss } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { SetupRepository } from "@hobbots/persistence";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { checkFolder } from "./folders.ts";

export const SetupHandlers = HttpApiBuilder.group(HobbotsApi, "setup", (handlers) =>
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    const chat = yield* ChatService;
    const grants = yield* GrantService;
    return handlers.handleAll({
      get: () => setup.get,
      // Folders are checked on the hub and stored resolved. A folder or provider added twice is
      // kept once, where it was first added.
      update: ({ payload }) =>
        Effect.gen(function* () {
          const folders =
            payload.approvedFolders &&
            (yield* Effect.forEach(payload.approvedFolders, (folder) => checkFolder(folder)));
          const before = yield* setup.get;
          const updated = yield* setup.update({
            ...payload,
            ...(folders && { approvedFolders: [...new Set(folders)] }),
            ...(payload.connectedProviders && { connectedProviders: [...new Set(payload.connectedProviders)] }),
          });
          // A narrower preset or a removed folder revokes the grants that relied on it (ADR 015), and
          // also reaches the turns already running (PE-008).
          yield* grants.revokeLost(null, setupLoss(before, updated));
          yield* chat.reviewAuthority();
          return updated;
        }),
    });
  }),
);

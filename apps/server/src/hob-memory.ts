import {
  EventPublisher,
  type FolderChecks,
  foundAgent,
  HobbotsRepository,
  hobMemoryScopes,
  type InstallationSettings,
  MemorySaves,
  MemoryStore,
  type MemoryStoreShape,
  undoMemorySave,
} from "@hobbots/agents";
import { HobbotsApi, MemoryNotAnswering, MemorySaveNotFound, MemorySaveNotUndoable } from "@hobbots/api";
import { makeMemoryStoreOff } from "@hobbots/memory";
import { DateTime, Effect, Option, Semaphore } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/**
 * Memory in a chat and on a hob's page (ADR 028, #961): the saves a thread's replies made, Undo for
 * one of them, and the scopes a hob reads. Everything goes through `MemoryStore` as you.
 */
export const HobMemoryHandlers = HttpApiBuilder.group(HobbotsApi, "hobMemory", (handlers) =>
  Effect.gen(function* () {
    // A hub built without memory, as most tests build it, answers that memory is not answering.
    const store: MemoryStoreShape = Option.getOrElse(yield* Effect.serviceOption(MemoryStore), () =>
      makeMemoryStoreOff("This hub has no memory."),
    );
    const saves = yield* Effect.serviceOption(MemorySaves);
    const publisher = yield* EventPublisher;
    const repo = yield* HobbotsRepository;
    const context = yield* Effect.context<InstallationSettings | FolderChecks>();
    // One Undo at a time, so two clicks never both write the earlier version back.
    const undoing = yield* Semaphore.make(1);
    return handlers.handleAll({
      threadSaves: ({ params }) => (Option.isNone(saves) ? Effect.succeed([]) : saves.value.inThread(params.threadId)),
      undoSave: ({ params }) =>
        Effect.gen(function* () {
          if (Option.isNone(saves)) return yield* new MemorySaveNotFound();
          const at = DateTime.formatIso(yield* DateTime.now);
          const undone = yield* undoMemorySave(store, saves.value, params.saveId, at);
          yield* publisher.publish(undone.entries);
          return undone.value;
        }).pipe(
          undoing.withPermit,
          Effect.catchTags({
            MemoryUnavailable: () => Effect.fail(new MemoryNotAnswering()),
            MemoryUndoRefused: ({ reason }) =>
              Effect.fail(reason === "missing" ? new MemorySaveNotFound() : new MemorySaveNotUndoable({ reason })),
          }),
        ),
      hobScopes: ({ params }) =>
        repo.findAgent(params.agentId).pipe(
          Effect.flatMap(foundAgent(params.agentId)),
          Effect.flatMap((agent) => hobMemoryScopes(store, agent)),
          Effect.map((scopes) => ({ scopes })),
          Effect.catchTag("MemoryUnavailable", () => Effect.fail(new MemoryNotAnswering())),
          Effect.provide(context),
        ),
    });
  }),
);

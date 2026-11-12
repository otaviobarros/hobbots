import { CatchUps, Notes } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { CatchUp } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

const NOTHING_NEW = new CatchUp({ readUpTo: null, firstUnread: null, replies: 0, items: [], more: 0 });

// Notes to self, pins and catch-up (ADR 037, #1387), for user sessions only (PE-006). A hub built
// without them, as in some tests, keeps no pins, takes no notes and has nothing to catch up on.
export const NotesHandlers = HttpApiBuilder.group(HobbotsApi, "notes", (handlers) =>
  Effect.gen(function* () {
    const notes = Option.getOrElse(yield* Effect.serviceOption(Notes), () =>
      Notes.of({
        write: () => Effect.die(new Error("This hub keeps no notes.")),
        setPinned: () => Effect.die(new Error("This hub keeps no pins.")),
        pins: () => Effect.succeed([]),
      }),
    );
    const catchUps = Option.getOrElse(yield* Effect.serviceOption(CatchUps), () =>
      CatchUps.of({ of: () => Effect.succeed(NOTHING_NEW) }),
    );
    return handlers.handleAll({
      writeNote: ({ params, payload }) => notes.write(params.threadId, payload.key, payload.content),
      pins: ({ params }) => notes.pins(params.threadId),
      pinMessage: ({ params, payload }) => notes.setPinned(params.threadId, params.messageId, payload.pinned),
      catchUp: ({ params }) => catchUps.of(params.threadId),
    });
  }),
);

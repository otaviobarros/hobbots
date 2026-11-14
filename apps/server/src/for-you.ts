import { ForYouList, sessionActor } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { ForYou } from "@hobbots/domain";
import { EventJournal } from "@hobbots/persistence";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { formatCursor } from "./event-stream.ts";

// For you (ADR 039, #1456), for user sessions only (PE-006): the list of the person whose device
// asks, read after the cursor so the stream brings every change since. A hub built without it, as
// in some tests, has nothing for anyone.
export const ForYouHandlers = HttpApiBuilder.group(HobbotsApi, "forYou", (handlers) =>
  Effect.gen(function* () {
    const journal = yield* EventJournal;
    const list = Option.getOrElse(yield* Effect.serviceOption(ForYouList), () =>
      ForYouList.of({ current: Effect.map(sessionActor, (you) => new ForYou({ for: you, items: [], away: [] })) }),
    );
    return handlers.handleAll({
      current: () =>
        Effect.gen(function* () {
          const head = yield* journal.head;
          return { cursor: formatCursor(head.epoch, head.sequence), forYou: yield* list.current };
        }),
    });
  }),
);
